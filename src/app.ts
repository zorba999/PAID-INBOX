import crypto from "node:crypto";
import express, { type Express, type NextFunction, type Request, type Response } from "express";
import cors from "cors";
import { configErrors, env, isProd } from "./env.js";
import {
  all,
  getUser,
  getUserByHandle,
  initDb,
  isBlocked,
  logEvent,
  normalizeThread,
  one,
  run,
  upsertUser,
  userStats,
  type ThreadRow,
  type UserRow,
} from "./db.js";
import { issueNonce, issueToken, requireAuth, verifyChallenge, verifyDetachedSignature } from "./auth.js";
import { feeFor, maybeSettleInBackground, reconcile, resolveOutcome, runSettlementTick } from "./settlement.js";
import { payoutRail } from "./payout.js";

const PUBKEY = /^0[23][0-9a-f]{64}$/i;

function bad(res: Response, message: string, code = 400): void {
  res.status(code).json({ error: message });
}

function normalizeHandle(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const h = raw.trim().replace(/^@+/, "").toLowerCase();
  return /^[a-z0-9_.-]{3,20}$/.test(h) ? h : null;
}

/** Wrap an async handler so a rejection reaches the error middleware. */
const ah =
  (fn: (req: Request, res: Response) => Promise<unknown>) =>
  (req: Request, res: Response, next: NextFunction) => {
    fn(req, res).catch(next);
  };

/* --------------------------------------------------------------- escrow */

let cachedRailAddress: string | null = null;

function escrowAddress(): string | null {
  return env.escrowAddress || cachedRailAddress;
}

export async function resolveEscrowAddress(): Promise<string | null> {
  if (!env.escrowAddress && payoutRail.mode === "sphere" && !cachedRailAddress) {
    cachedRailAddress = await payoutRail.address();
  }
  return escrowAddress();
}

/* ----------------------------------------------------------------- DTOs */

async function publicUser(u: UserRow) {
  return {
    pubkey: u.pubkey,
    handle: u.handle,
    displayName: u.display_name,
    bio: u.bio,
    priceBase: u.price_base,
    replyWindowHours: u.reply_window_hours,
    isOpen: !!u.is_open,
    stats: await userStats(u.pubkey),
  };
}

async function threadDto(t: ThreadRow, viewer: string) {
  const [sender, recipient] = await Promise.all([
    getUser(t.sender_pubkey),
    getUser(t.recipient_pubkey),
  ]);
  const { fee, net } = feeFor(t.price_base);

  return {
    id: t.id,
    ref: t.ref,
    subject: t.subject,
    state: t.state,
    priceBase: t.price_base,
    coinId: t.coin_id,
    feeBase: fee,
    netBase: net,
    payoutPolicy: t.payout_policy,
    role: viewer === t.sender_pubkey ? "sender" : "recipient",
    sender: { pubkey: t.sender_pubkey, handle: sender?.handle ?? null },
    recipient: { pubkey: t.recipient_pubkey, handle: recipient?.handle ?? null },
    transferId: t.transfer_id,
    deliveryPending: !!t.delivery_pending,
    messageId: t.message_id,
    messageAt: t.message_at,
    replyMessageId: t.reply_message_id,
    replyAt: t.reply_at,
    deadlineAt: t.deadline_at,
    confirmUntil: t.confirm_until,
    settledAt: t.settled_at,
    payeePubkey: t.payee_pubkey,
    disputeReason: t.dispute_reason,
    createdAt: t.created_at,
    /** What happens if nobody does anything else. Rendered as the deal line. */
    outcomeIfSilent: resolveOutcome(t, false).payee,
    outcomeIfReplied: resolveOutcome(t, true).payee,
  };
}

async function getThread(id: string): Promise<ThreadRow | undefined> {
  const r = await one<ThreadRow>("SELECT * FROM threads WHERE id = $1", id);
  return r ? normalizeThread(r) : undefined;
}

/* ============================================================== the app */

export function createApp(): Express {
  const app = express();
  app.use(express.json({ limit: "256kb" }));

  /* ------------------------------------------------------------- CORS
   *
   * A refused origin is the most misleading failure in this stack: the request
   * reaches the server, the server answers 200, and the browser drops it for
   * want of a header. The dApp only ever sees a bare fetch rejection, which
   * reads as "the API is down". So: permissive where safe, loud where not.
   */
  const allowList =
    env.origin === "*" ? null : env.origin.split(",").map((o) => o.trim()).filter(Boolean);
  const LOOPBACK = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/;

  app.use(
    cors({
      origin(origin, cb) {
        if (!origin) return cb(null, true); // curl, same-origin, server-to-server
        if (!allowList) return cb(null, true);
        if (allowList.includes(origin)) return cb(null, true);
        if (!isProd && LOOPBACK.test(origin)) return cb(null, true);
        console.warn(`[cors] refused ${origin}; not in CORS_ORIGIN (${env.origin})`);
        return cb(null, false);
      },
    }),
  );

  /* A deployment missing a required variable answers with the list, on every
   * route, instead of crashing the invocation and leaving the caller with an
   * opaque platform error. /api/health is exempt so it can report them. */
  app.use((req, res, next) => {
    if (!configErrors.length || req.path === "/api/health") return next();
    res.status(503).json({
      error: "This deployment is not configured correctly and is not serving requests.",
      problems: configErrors,
    });
  });

  /* Serverless has no timer, so traffic is what drives settlement. Throttled
   * inside, and never awaited by the request that triggered it. */
  app.use((_req, _res, next) => {
    maybeSettleInBackground();
    next();
  });

  /* ---------------------------------------------------------- config */

  app.get(
    "/api/config",
    ah(async (_req, res) => {
      const escrow = await resolveEscrowAddress();
      res.json({
        coinId: env.coinId,
        coinSymbol: env.coinSymbol,
        coinDecimals: env.coinDecimals,
        feeBps: env.feeBps,
        payoutPolicy: env.payoutPolicy,
        minPriceBase: env.minPriceBase,
        maxPriceBase: env.maxPriceBase,
        disputeWindowHours: env.disputeWindowHours,
        minReplyChars: env.minReplyChars,
        escrowAddress: escrow,
        escrowConfigured: !!escrow,
        payoutMode: payoutRail.mode,
        allowDemo: env.allowDemo,
        network: env.network,
      });
    }),
  );

  app.get(
    "/api/health",
    ah(async (_req, res) => {
      if (configErrors.length) {
        return res.status(503).json({ ok: false, problems: configErrors, at: Date.now() });
      }
      await initDb();
      res.json({ ok: true, storage: env.postgresUrl ? "postgres" : "pglite", at: Date.now() });
    }),
  );

  /* ------------------------------------------------------------ auth */

  app.post(
    "/api/auth/nonce",
    ah(async (req, res) => {
      const pubkey = String(req.body?.pubkey ?? "");
      if (!PUBKEY.test(pubkey)) return bad(res, "pubkey must be a 66-char compressed secp256k1 key");
      res.json(await issueNonce(pubkey));
    }),
  );

  app.post(
    "/api/auth/verify",
    ah(async (req, res) => {
      const { pubkey, nonce, signature, nametag } = req.body ?? {};
      if (!PUBKEY.test(String(pubkey ?? ""))) return bad(res, "Invalid pubkey");
      if (typeof nonce !== "string" || typeof signature !== "string") {
        return bad(res, "nonce and signature are required");
      }

      const result = await verifyChallenge(pubkey, nonce, signature);
      if (!result.ok) return bad(res, result.reason ?? "Verification failed", 401);

      const user = await upsertUser(pubkey, normalizeHandle(nametag));
      res.json({ token: issueToken(pubkey, result.demo), user: await publicUser(user), demo: result.demo });
    }),
  );

  /* -------------------------------------------------------------- me */

  app.get(
    "/api/me",
    requireAuth,
    ah(async (req, res) => {
      res.json({ user: await publicUser(req.user!), demo: !!req.isDemoSession });
    }),
  );

  app.patch(
    "/api/me",
    requireAuth,
    ah(async (req, res) => {
      const u = req.user!;
      const { displayName, bio, priceBase, replyWindowHours, isOpen, handle } = req.body ?? {};

      if (priceBase !== undefined) {
        if (typeof priceBase !== "string" || !/^\d+$/.test(priceBase)) {
          return bad(res, "priceBase must be base units");
        }
        if (BigInt(priceBase) < BigInt(env.minPriceBase)) return bad(res, "Price below the platform minimum");
        if (BigInt(priceBase) > BigInt(env.maxPriceBase)) return bad(res, "Price above the platform maximum");
      }
      if (replyWindowHours !== undefined) {
        const h = Number(replyWindowHours);
        if (!Number.isInteger(h) || h < 1 || h > 336) return bad(res, "replyWindowHours must be 1-336");
      }

      let nextHandle: string | null = null;
      if (handle !== undefined && handle !== null) {
        nextHandle = normalizeHandle(handle);
        if (!nextHandle) return bad(res, "Handle must be 3-20 chars: a-z 0-9 . _ -");
        const clash = await getUserByHandle(nextHandle);
        if (clash && clash.pubkey !== u.pubkey) return bad(res, "That handle is taken", 409);
      }

      await run(
        `UPDATE users SET
           display_name = COALESCE($1, display_name),
           bio = COALESCE($2, bio),
           price_base = COALESCE($3, price_base),
           reply_window_hours = COALESCE($4, reply_window_hours),
           is_open = COALESCE($5, is_open),
           handle = COALESCE($6, handle),
           updated_at = $7
         WHERE pubkey = $8`,
        typeof displayName === "string" ? displayName.slice(0, 60) : null,
        typeof bio === "string" ? bio.slice(0, 280) : null,
        priceBase ?? null,
        replyWindowHours !== undefined ? Number(replyWindowHours) : null,
        isOpen === undefined ? null : isOpen ? 1 : 0,
        nextHandle,
        Date.now(),
        u.pubkey,
      );

      res.json({ user: await publicUser((await getUser(u.pubkey))!) });
    }),
  );

  /* -------------------------------------------------------- profiles */

  app.get(
    "/api/u/:handle",
    ah(async (req, res) => {
      const key = String(req.params.handle);
      const user = PUBKEY.test(key) ? await getUser(key) : await getUserByHandle(key.replace(/^@/, ""));
      if (!user) return bad(res, "No such inbox", 404);
      res.json({ user: await publicUser(user) });
    }),
  );

  app.get(
    "/api/directory",
    ah(async (_req, res) => {
      const rows = await all<UserRow>(
        "SELECT * FROM users WHERE is_open = 1 AND handle IS NOT NULL ORDER BY updated_at DESC LIMIT 60",
      );
      res.json({ users: await Promise.all(rows.map(publicUser)) });
    }),
  );

  /* --------------------------------------------------------- threads */

  /**
   * Step 1 of the send flow: reserve the thread and hand back everything the
   * dApp needs for the `send` intent.
   */
  app.post(
    "/api/threads",
    requireAuth,
    ah(async (req, res) => {
      const me = req.user!;
      const { to, subject } = req.body ?? {};

      const target = typeof to === "string" ? to.trim() : "";
      if (!target) return bad(res, "Recipient is required");
      if (typeof subject !== "string" || subject.trim().length < 3) return bad(res, "Subject is too short");

      const recipient = PUBKEY.test(target)
        ? await getUser(target)
        : await getUserByHandle(target.replace(/^@/, ""));

      if (!recipient) return bad(res, "That inbox does not exist yet", 404);
      if (recipient.pubkey === me.pubkey) return bad(res, "You cannot pay to reach yourself");
      if (!recipient.is_open) return bad(res, "This inbox is closed", 403);
      if (await isBlocked(recipient.pubkey, me.pubkey)) return bad(res, "You cannot reach this inbox", 403);

      const escrow = await resolveEscrowAddress();
      if (!escrow) {
        return bad(
          res,
          "This server has no escrow address configured, so there is nowhere to pay. Set ESCROW_ADDRESS to a registered nametag or a DIRECT:// address.",
          503,
        );
      }

      const now = Date.now();
      const id = crypto.randomUUID();
      const ref = `pi_${crypto.randomBytes(6).toString("hex")}`;

      await run(
        `INSERT INTO threads (id, ref, sender_pubkey, recipient_pubkey, subject, price_base, coin_id,
                              state, payout_policy, delivery_pending, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 'PAYING', $8, 0, $9, $10)`,
        id,
        ref,
        me.pubkey,
        recipient.pubkey,
        subject.trim().slice(0, 140),
        recipient.price_base,
        env.coinId,
        env.payoutPolicy, // frozen: a later settings change never rewrites this deal
        now,
        now,
      );

      await logEvent(id, "created", { to: recipient.pubkey, price: recipient.price_base });

      res.json({
        thread: await threadDto((await getThread(id))!, me.pubkey),
        payment: {
          to: escrow,
          amount: recipient.price_base,
          coinId: env.coinId,
          memo: `paidinbox:${ref}`,
        },
        recipient: await publicUser(recipient),
      });
    }),
  );

  /** Step 2: the wallet accepted the `send` intent. */
  app.post(
    "/api/threads/:id/paid",
    requireAuth,
    ah(async (req, res) => {
      const me = req.user!;
      const t = await getThread(String(req.params.id));
      if (!t) return bad(res, "No such thread", 404);
      if (t.sender_pubkey !== me.pubkey) return bad(res, "Not your thread", 403);
      if (t.state !== "PAYING" && t.state !== "PENDING_RECONCILE") {
        return bad(res, `Thread is already ${t.state}`, 409);
      }

      const { transferId, deliveryPending } = req.body ?? {};
      const now = Date.now();

      await run(
        "UPDATE threads SET state = 'ESCROWED', transfer_id = $1, delivery_pending = $2, updated_at = $3 WHERE id = $4",
        typeof transferId === "string" ? transferId : null,
        deliveryPending ? 1 : 0,
        now,
        t.id,
      );

      await run(
        `INSERT INTO ledger (id, thread_id, kind, pubkey, amount_base, transfer_id, status, at)
         VALUES ($1, $2, 'escrow_in', $3, $4, $5, 'settled', $6)
         ON CONFLICT (thread_id, kind) DO NOTHING`,
        crypto.randomUUID(),
        t.id,
        me.pubkey,
        t.price_base,
        typeof transferId === "string" ? transferId : null,
        now,
      );

      await logEvent(t.id, "escrowed", { transferId, deliveryPending: !!deliveryPending });
      res.json({ thread: await threadDto((await getThread(t.id))!, me.pubkey) });
    }),
  );

  /**
   * Step 3: the DM went out from the sender's own wallet, end to end encrypted.
   * We record a message id and a hash, never the body. The reply deadline
   * starts here, not at payment: the clock must not run while the message is
   * still in flight.
   */
  app.post(
    "/api/threads/:id/delivered",
    requireAuth,
    ah(async (req, res) => {
      const me = req.user!;
      const t = await getThread(String(req.params.id));
      if (!t) return bad(res, "No such thread", 404);
      if (t.sender_pubkey !== me.pubkey) return bad(res, "Not your thread", 403);
      if (t.state !== "ESCROWED") return bad(res, `Thread is ${t.state}, not ESCROWED`, 409);

      const { messageId, timestamp, bodyHash } = req.body ?? {};
      if (typeof messageId !== "string" || !messageId) return bad(res, "messageId is required");

      const recipient = (await getUser(t.recipient_pubkey))!;
      const at = Number(timestamp) || Date.now();
      const deadline = at + recipient.reply_window_hours * 3600_000;

      await run(
        `UPDATE threads SET state = 'DELIVERED', message_id = $1, message_at = $2, body_hash = $3,
                deadline_at = $4, updated_at = $5
         WHERE id = $6`,
        messageId,
        at,
        typeof bodyHash === "string" ? bodyHash : null,
        deadline,
        Date.now(),
        t.id,
      );

      await logEvent(t.id, "delivered", { messageId, deadline });
      res.json({ thread: await threadDto((await getThread(t.id))!, me.pubkey) });
    }),
  );

  /** The 4201 path: the wallet took the intent and the answer was lost. */
  app.post(
    "/api/threads/:id/reconcile",
    requireAuth,
    ah(async (req, res) => {
      const me = req.user!;
      const t = await getThread(String(req.params.id));
      if (!t) return bad(res, "No such thread", 404);
      if (t.sender_pubkey !== me.pubkey) return bad(res, "Not your thread", 403);
      if (t.state !== "PAYING") return bad(res, `Thread is ${t.state}`, 409);

      await run("UPDATE threads SET state = 'PENDING_RECONCILE', updated_at = $1 WHERE id = $2", Date.now(), t.id);
      await logEvent(t.id, "pending_reconcile", { note: req.body?.note ?? null });
      res.json({ thread: await threadDto((await getThread(t.id))!, me.pubkey) });
    }),
  );

  /* ----------------------------------------------------------- reply */

  /**
   * The recipient proves a reply happened without us ever seeing the message.
   * We hand out a nonce; the wallet signs a statement binding thread, message
   * id and timestamp; we recover the pubkey and check it is the recipient's.
   */
  app.post(
    "/api/threads/:id/reply-challenge",
    requireAuth,
    ah(async (req, res) => {
      const me = req.user!;
      const t = await getThread(String(req.params.id));
      if (!t) return bad(res, "No such thread", 404);
      if (t.recipient_pubkey !== me.pubkey) return bad(res, "Not your inbox", 403);
      if (t.state !== "DELIVERED") return bad(res, `Thread is ${t.state}, not DELIVERED`, 409);

      const { messageId, timestamp } = req.body ?? {};
      if (typeof messageId !== "string" || !messageId) return bad(res, "messageId is required");

      const nonce = crypto.randomBytes(12).toString("base64url");
      const at = Number(timestamp) || Date.now();

      const message = [
        "Paid Inbox: reply attestation",
        "",
        `Thread: ${t.id}`,
        `Ref: ${t.ref}`,
        `Reply message: ${messageId}`,
        `Replied at: ${new Date(at).toISOString()}`,
        `Nonce: ${nonce}`,
        "",
        "Signing releases the escrow according to the deal shown in the app.",
      ].join("\n");

      await run(
        "INSERT INTO nonces (nonce, pubkey, message, created_at, used) VALUES ($1, $2, $3, $4, 0)",
        nonce,
        me.pubkey,
        message,
        Date.now(),
      );

      res.json({ nonce, message, messageId, timestamp: at });
    }),
  );

  app.post(
    "/api/threads/:id/reply",
    requireAuth,
    ah(async (req, res) => {
      const me = req.user!;
      const t = await getThread(String(req.params.id));
      if (!t) return bad(res, "No such thread", 404);
      if (t.recipient_pubkey !== me.pubkey) return bad(res, "Not your inbox", 403);
      if (t.state !== "DELIVERED") return bad(res, `Thread is ${t.state}, not DELIVERED`, 409);

      const { nonce, signature, replyLength } = req.body ?? {};
      if (typeof nonce !== "string" || typeof signature !== "string") {
        return bad(res, "nonce and signature are required");
      }

      const len = Number(replyLength ?? 0);
      if (!Number.isFinite(len) || len < env.minReplyChars) {
        return bad(res, `A reply must be at least ${env.minReplyChars} characters to release the escrow`);
      }

      const row = await one<{ pubkey: string; message: string; used: number; created_at: number }>(
        "SELECT * FROM nonces WHERE nonce = $1",
        nonce,
      );

      if (!row || row.used) return bad(res, "Unknown or spent nonce", 401);
      if (row.pubkey !== me.pubkey) return bad(res, "Nonce belongs to another key", 401);
      if (Date.now() - Number(row.created_at) > 10 * 60_000) return bad(res, "Attestation expired, try again", 401);
      if (!verifyDetachedSignature(row.message, signature, me.pubkey)) {
        return bad(res, "Signature does not match your key", 401);
      }

      const messageId = /Reply message: (.+)/.exec(row.message)?.[1] ?? null;
      const now = Date.now();
      const confirmUntil = now + env.disputeWindowHours * 3600_000;

      await run("UPDATE nonces SET used = 1 WHERE nonce = $1", nonce);
      await run(
        `UPDATE threads SET state = 'REPLIED', reply_message_id = $1, reply_at = $2, reply_signature = $3,
                reply_attestation = $4, reply_len = $5, confirm_until = $6, updated_at = $7
         WHERE id = $8`,
        messageId,
        now,
        signature,
        row.message,
        Math.floor(len),
        confirmUntil,
        now,
        t.id,
      );

      await logEvent(t.id, "replied", { messageId, replyLength: Math.floor(len), confirmUntil });
      res.json({ thread: await threadDto((await getThread(t.id))!, me.pubkey) });
    }),
  );

  /* --------------------------------------------------------- dispute */

  app.post(
    "/api/threads/:id/dispute",
    requireAuth,
    ah(async (req, res) => {
      const me = req.user!;
      const t = await getThread(String(req.params.id));
      if (!t) return bad(res, "No such thread", 404);
      if (t.sender_pubkey !== me.pubkey) return bad(res, "Only the sender can dispute", 403);
      if (t.state !== "REPLIED") return bad(res, `Thread is ${t.state}, not REPLIED`, 409);
      if (t.confirm_until && t.confirm_until <= Date.now()) return bad(res, "The dispute window has closed", 409);

      const reason = String(req.body?.reason ?? "").slice(0, 400);
      await run(
        "UPDATE threads SET state = 'DISPUTED', dispute_reason = $1, updated_at = $2 WHERE id = $3",
        reason || null,
        Date.now(),
        t.id,
      );
      await logEvent(t.id, "disputed", { reason });
      res.json({ thread: await threadDto((await getThread(t.id))!, me.pubkey) });
    }),
  );

  /* ----------------------------------------------------------- lists */

  app.get(
    "/api/inbox",
    requireAuth,
    ah(async (req, res) => {
      const rows = await all<ThreadRow>(
        `SELECT * FROM threads WHERE recipient_pubkey = $1 AND state <> 'PAYING'
          ORDER BY CASE state WHEN 'DELIVERED' THEN 0 WHEN 'REPLIED' THEN 1 ELSE 2 END,
                   LENGTH(price_base) DESC, price_base DESC, created_at DESC
          LIMIT 200`,
        req.user!.pubkey,
      );
      res.json({
        threads: await Promise.all(rows.map((r) => threadDto(normalizeThread(r), req.user!.pubkey))),
      });
    }),
  );

  app.get(
    "/api/sent",
    requireAuth,
    ah(async (req, res) => {
      const rows = await all<ThreadRow>(
        "SELECT * FROM threads WHERE sender_pubkey = $1 ORDER BY created_at DESC LIMIT 200",
        req.user!.pubkey,
      );
      res.json({
        threads: await Promise.all(rows.map((r) => threadDto(normalizeThread(r), req.user!.pubkey))),
      });
    }),
  );

  app.get(
    "/api/threads/:id",
    requireAuth,
    ah(async (req, res) => {
      const t = await getThread(String(req.params.id));
      if (!t) return bad(res, "No such thread", 404);
      const me = req.user!.pubkey;
      if (t.sender_pubkey !== me && t.recipient_pubkey !== me) return bad(res, "Not your thread", 403);

      const events = await all<{ type: string; detail: string | null; at: number }>(
        "SELECT type, detail, at FROM thread_events WHERE thread_id = $1 ORDER BY id ASC",
        t.id,
      );

      res.json({
        thread: await threadDto(t, me),
        events: events.map((e) => ({
          type: e.type,
          at: Number(e.at),
          detail: e.detail ? JSON.parse(e.detail) : null,
        })),
      });
    }),
  );

  /* ---------------------------------------------------------- blocks */

  app.post(
    "/api/blocks",
    requireAuth,
    ah(async (req, res) => {
      const target = String(req.body?.pubkey ?? "");
      if (!PUBKEY.test(target)) return bad(res, "Invalid pubkey");
      await run(
        `INSERT INTO blocks (owner_pubkey, blocked_pubkey, at) VALUES ($1, $2, $3)
         ON CONFLICT (owner_pubkey, blocked_pubkey) DO NOTHING`,
        req.user!.pubkey,
        target,
        Date.now(),
      );
      res.json({ ok: true });
    }),
  );

  app.delete(
    "/api/blocks/:pubkey",
    requireAuth,
    ah(async (req, res) => {
      await run(
        "DELETE FROM blocks WHERE owner_pubkey = $1 AND blocked_pubkey = $2",
        req.user!.pubkey,
        String(req.params.pubkey),
      );
      res.json({ ok: true });
    }),
  );

  /* --------------------------------------------------- transparency */

  app.get(
    "/api/reconciliation",
    ah(async (_req, res) => {
      res.json(await reconcile());
    }),
  );

  app.get(
    "/api/stats",
    ah(async (_req, res) => {
      const counts = await all<{ state: string; n: string }>(
        "SELECT state, COUNT(*) AS n FROM threads GROUP BY state",
      );
      const users = await one<{ n: string }>("SELECT COUNT(*) AS n FROM users");
      const volume = await all<{ price_base: string }>(
        "SELECT price_base FROM threads WHERE state <> 'PAYING'",
      );

      res.json({
        users: Number(users?.n ?? 0),
        byState: Object.fromEntries(counts.map((c) => [c.state, Number(c.n)])),
        volumeBase: volume.reduce((a, r) => a + BigInt(r.price_base), 0n).toString(),
      });
    }),
  );

  /**
   * Settlement for a deployment with no traffic. Vercel Cron calls this; the
   * bearer check is skipped when CRON_SECRET is unset so local runs are easy.
   */
  app.get(
    "/api/cron/settle",
    ah(async (req, res) => {
      if (env.cronSecret) {
        const auth = req.headers.authorization ?? "";
        if (auth !== `Bearer ${env.cronSecret}`) return bad(res, "Not authorised", 401);
      }
      res.json(await runSettlementTick());
    }),
  );

  /* ---------------------------------------------------------- errors */

  /* Report the path that was actually routed. A bare "No such endpoint" hides
   * the one thing worth knowing when a rewrite reshapes the URL on the way in. */
  app.use((req: Request, res: Response) => {
    res.status(404).json({ error: "No such endpoint", method: req.method, path: req.path, url: req.url });
  });

  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    console.error("[api]", err);
    res.status(500).json({ error: "Internal error" });
  });

  return app;
}
