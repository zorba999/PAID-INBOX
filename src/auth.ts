import crypto from "node:crypto";
import type { NextFunction, Request, Response } from "express";
import { verifySignedMessage } from "@unicitylabs/sphere-sdk";
import { getUser, one, run, upsertUser, type UserRow } from "./db.js";
import { env } from "./env.js";

/* ==========================================================================
 * Sign in with Sphere
 *
 * 1. dApp asks for a nonce.
 * 2. The wallet signs a human-readable challenge (`sign_message`), showing the
 *    full text to the user first.
 * 3. We recover the pubkey from the signature and compare it to the claimed
 *    one. The pubkey, never the nametag, is the identity.
 * ========================================================================== */

const NONCE_TTL_MS = 5 * 60 * 1000;

export function buildChallenge(pubkey: string, nonce: string): string {
  return [
    "Sign in to Paid Inbox",
    "",
    `Domain: ${env.origin === "*" ? "localhost" : env.origin}`,
    `Key: ${pubkey}`,
    `Nonce: ${nonce}`,
    `Issued At: ${new Date().toISOString()}`,
    "",
    "Signing proves you control this wallet. It does not move any funds.",
  ].join("\n");
}

export async function issueNonce(pubkey: string): Promise<{ nonce: string; message: string }> {
  const nonce = crypto.randomBytes(16).toString("base64url");
  const message = buildChallenge(pubkey, nonce);
  await run(
    "INSERT INTO nonces (nonce, pubkey, message, created_at, used) VALUES ($1, $2, $3, $4, 0)",
    nonce,
    pubkey,
    message,
    Date.now(),
  );
  return { nonce, message };
}

/**
 * A DEMO signature is `de` + sha256(message + pubkey) repeated to 130 chars. It
 * proves the caller knew the message and the public key, and a public key is
 * public. It is NOT an identity proof, so it is gated behind ALLOW_DEMO and
 * refused outright in production.
 */
function isValidDemoSignature(message: string, signature: string, pubkey: string): boolean {
  if (!env.allowDemo) return false;
  if (!signature.startsWith("de")) return false;
  const hex = crypto.createHash("sha256").update(message + pubkey).digest("hex");
  return signature === `de${hex}${hex}`.slice(0, 130);
}

export interface VerifyResult {
  ok: boolean;
  demo: boolean;
  reason?: string;
}

export async function verifyChallenge(
  pubkey: string,
  nonce: string,
  signature: string,
): Promise<VerifyResult> {
  const row = await one<{ pubkey: string; message: string; created_at: number; used: number }>(
    "SELECT * FROM nonces WHERE nonce = $1",
    nonce,
  );

  if (!row) return { ok: false, demo: false, reason: "Unknown nonce" };
  if (row.used) return { ok: false, demo: false, reason: "Nonce already used" };
  if (row.pubkey !== pubkey) return { ok: false, demo: false, reason: "Nonce belongs to another key" };
  if (Date.now() - Number(row.created_at) > NONCE_TTL_MS) {
    return { ok: false, demo: false, reason: "Nonce expired" };
  }

  let ok = false;
  let demo = false;

  try {
    ok = verifySignedMessage(row.message, signature, pubkey);
  } catch {
    ok = false;
  }

  if (!ok && isValidDemoSignature(row.message, signature, pubkey)) {
    ok = true;
    demo = true;
  }

  if (ok) await run("UPDATE nonces SET used = 1 WHERE nonce = $1", nonce);
  return ok ? { ok, demo } : { ok: false, demo: false, reason: "Signature does not match the key" };
}

/** Same verification path, reused for the reply attestation. */
export function verifyDetachedSignature(message: string, signature: string, pubkey: string): boolean {
  try {
    if (verifySignedMessage(message, signature, pubkey)) return true;
  } catch {
    /* fall through to the demo check */
  }
  return isValidDemoSignature(message, signature, pubkey);
}

/* ------------------------------------------------------------- session token
 * HMAC-signed and stateless, so it needs no storage round trip on a cold start:
 * base64url(payload).base64url(sig)
 * ------------------------------------------------------------------------- */

function sign(data: string): string {
  return crypto.createHmac("sha256", env.authSecret).update(data).digest("base64url");
}

export function issueToken(pubkey: string, demo: boolean): string {
  const payload = Buffer.from(
    JSON.stringify({ sub: pubkey, demo, exp: Date.now() + env.tokenTtlMs }),
  ).toString("base64url");
  return `${payload}.${sign(payload)}`;
}

export function readToken(token: string): { sub: string; demo: boolean } | null {
  const [payload, mac] = token.split(".");
  if (!payload || !mac) return null;

  const a = Buffer.from(mac);
  const b = Buffer.from(sign(payload));
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;

  try {
    const claims = JSON.parse(Buffer.from(payload, "base64url").toString()) as {
      sub: string;
      demo: boolean;
      exp: number;
    };
    if (claims.exp < Date.now()) return null;
    return { sub: claims.sub, demo: claims.demo };
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------- middleware */

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: UserRow;
      isDemoSession?: boolean;
    }
  }
}

export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  const header = req.headers.authorization ?? "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";
  const claims = token ? readToken(token) : null;

  if (!claims) {
    res.status(401).json({ error: "Not authenticated" });
    return;
  }

  void (async () => {
    try {
      req.user = (await getUser(claims.sub)) ?? (await upsertUser(claims.sub, null));
      req.isDemoSession = claims.demo;
      next();
    } catch (err) {
      next(err);
    }
  })();
}
