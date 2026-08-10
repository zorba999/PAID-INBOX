import crypto from "node:crypto";
import express, { type Request, type Response } from "express";
import cors from "cors";
import { env, isProd } from "./env.js";
import {
  all,
  db,
  getUser,
  getUserByHandle,
  isBlocked,
  logEvent,
  one,
  upsertUser,
  userStats,
  type ThreadRow,
  type UserRow,
} from "./db.js";
import { issueNonce, issueToken, requireAuth, verifyChallenge, verifyDetachedSignature } from "./auth.js";
import { feeFor, reconcile, resolveOutcome, startSettlementLoop } from "./settlement.js";
import { payoutRail } from "./payout.js";

const app = express();
app.use(express.json({ limit: "256kb" }));

/* --------------------------------------------------------------------- CORS
 *
 * A rejected origin is the single most confusing failure in this stack: the
 * request succeeds, the response comes back 200, and the browser drops it for
 * want of a header — the dApp only ever sees "Failed to fetch". So the rule is
 * permissive where it is safe and LOUD where it is not.
 *
 * CORS_ORIGIN takes `*` or a comma-separated list. Outside production any
 * loopback origin is allowed regardless of port, because the dev server picks
 * a new port whenever 5174 is taken and 127.0.0.1 is not the same origin as
 * localhost.
 * ------------------------------------------------------------------------ */

const allowList =
  env.origin === "*" ? null : env.origin.split(",").map((o) => o.trim()).filter(Boolean);

const LOOPBACK = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/;

app.use(
  cors({
    origin(origin, cb) {
      // No Origin header: curl, same-origin, server-to-server. Nothing to gate.
      if (!origin) return cb(null, true);
      if (!allowList) return cb(null, true);
      if (allowList.includes(origin)) return cb(null, true);
      if (!isProd && LOOPBACK.test(origin)) return cb(null, true);

      console.warn(
        `[cors] refused ${origin} — it is not in CORS_ORIGIN (${env.origin}).` +
          ` The browser will report this as "Failed to fetch".`,
      );
      return cb(null, false);
    },
  }),
);

/* ------------------------------------------------------------------ utils */

const PUBKEY = /^0[23][0-9a-f]{64}$/i;

function bad(res: Response, message: string, code = 400): void {
  res.status(code).json({ error: message });
}

function normalizeHandle(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const h = raw.trim().replace(/^@+/, "").toLowerCase();
  return /^[a-z0-9_.-]{3,20}$/.test(h) ? h : null;
}

function publicUser(u: UserRow) {
  return {
    pubkey: u.pubkey,
    handle: u.handle,
    displayName: u.display_name,
    bio: u.bio,
    priceBase: u.price_base,
    replyWindowHours: u.reply_window_hours,
    isOpen: !!u.is_open,
    stats: userStats(u.pubkey),
  };
}

function threadDto(t: ThreadRow, viewer: string) {
  const sender = getUser(t.sender_pubkey);
  const recipient = getUser(t.recipient_pubkey);
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
    /** What happens if nobody does anything else. Rendered as the "deal" line. */
    outcomeIfSilent: resolveOutcome(t, false).payee,
    outcomeIfReplied: resolveOutcome(t, true).payee,
  };
}

function getThread(id: string): ThreadRow | undefined {
  return one<ThreadRow>("SELECT * FROM threads WHERE id = ?", id);
}

/**
 * Where senders pay. On the sphere rail the escrow wallet knows its own
 * address, so ESCROW_ADDRESS is only needed to override it (or to point at a
 * wallet this server does not run).
 *
 * There is deliberately no default: a placeholder nametag nobody registered
 * makes every `send` intent fail with INVALID_RECIPIENT, and it fails in the
 * wallet, where the message is useless to whoever is debugging.
 */
let cachedRailAddress: string | null = null;

function escrowAddress(): string | null {
  return env.escrowAddress || cachedRailAddress;
}

/* ------------------------------------------------------------------ config */

app.get("/api/config", async (_req, res) => {
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
    escrowAddress: escrowAddress(),
    escrowConfigured: !!escrowAddress(),
    payoutMode: payoutRail.mode,
    allowDemo: env.allowDemo,
    network: env.network,
  });
});

app.get("/api/health", (_req, res) => res.json({ ok: true, at: Date.now() }));

/* -------------------------------------------------------------------- auth */

app.post("/api/auth/nonce", (req, res) => {
  const pubkey = String(req.body?.pubkey ?? "");
  if (!PUBKEY.test(pubkey)) return bad(res, "pubkey must be a 66-char compressed secp256k1 key");
  res.json(issueNonce(pubkey));
});

app.post("/api/auth/verify", (req, res) => {
  const { pubkey, nonce, signature, nametag } = req.body ?? {};
  if (!PUBKEY.test(String(pubkey ?? ""))) return bad(res, "Invalid pubkey");
  if (typeof nonce !== "string" || typeof signature !== "string") return bad(res, "nonce and signature are required");

  const result = verifyChallenge(pubkey, nonce, signature);
  if (!result.ok) return bad(res, result.reason ?? "Verification failed", 401);

  const user = upsertUser(pubkey, normalizeHandle(nametag));
  res.json({ token: issueToken(pubkey, result.demo), user: publicUser(user), demo: result.demo });
});

/* --------------------------------------------------------------------- me */

app.get("/api/me", requireAuth, (req, res) => {
  res.json({ user: publicUser(req.user!), demo: !!req.isDemoSession });
});

app.patch("/api/me", requireAuth, (req, res) => {
  const u = req.user!;
  const { displayName, bio, priceBase, replyWindowHours, isOpen, handle } = req.body ?? {};

  if (priceBase !== undefined) {
    if (typeof priceBase !== "string" || !/^\d+$/.test(priceBase)) return bad(res, "priceBase must be base units");
    if (BigInt(priceBase) < BigInt(env.minPriceBase)) return bad(res, "Price below the platform minimum");
    if (BigInt(priceBase) > BigInt(env.maxPriceBase)) return bad(res, "Price above the platform maximum");
  }
  if (replyWindowHours !== undefined) {
    const h = Number(replyWindowHours);
    if (!Number.isInteger(h) || h < 1 || h > 336) return bad(res, "replyWindowHours must be 1–336");
  }
  if (handle !== undefined && handle !== null) {
    const h = normalizeHandle(handle);
    if (!h) return bad(res, "Handle must be 3–20 chars: a-z 0-9 . _ -");
    const clash = getUserByHandle(h);
    if (clash && clash.pubkey !== u.pubkey) return bad(res, "That handle is taken", 409);
  }

  db.prepare(
    `UPDATE users SET
       display_name = COALESCE(?, display_name),
       bio = COALESCE(?, bio),
       price_base = COALESCE(?, price_base),
       reply_window_hours = COALESCE(?, reply_window_hours),
       is_open = COALESCE(?, is_open),
       handle = COALESCE(?, handle),
       updated_at = ?
     WHERE pubkey = ?`,
  ).run(
    typeof displayName === "string" ? displayName.slice(0, 60) : null,
    typeof bio === "string" ? bio.slice(0, 280) : null,
    priceBase ?? null,
    replyWindowHours !== undefined ? Number(replyWindowHours) : null,
    isOpen === undefined ? null : isOpen ? 1 : 0,
    handle === undefined || handle === null ? null : normalizeHandle(handle),
    Date.now(),
    u.pubkey,
  );

  res.json({ user: publicUser(getUser(u.pubkey)!) });
});

/* ---------------------------------------------------------------- profiles */

app.get("/api/u/:handle", (req, res) => {
  const key = String(req.params.handle);
  const user = PUBKEY.test(key) ? getUser(key) : getUserByHandle(key.replace(/^@/, ""));
  if (!user) return bad(res, "No such inbox", 404);
  res.json({ user: publicUser(user) });
});

app.get("/api/directory", (_req, res) => {
  const rows = all<UserRow>("SELECT * FROM users WHERE is_open = 1 AND handle IS NOT NULL ORDER BY updated_at DESC LIMIT 60");
  res.json({ users: rows.map(publicUser) });
});

/* ----------------------------------------------------------------- threads */

/**
 * Step 1 of the send flow. Creates the escrow intent and hands back everything
 * the dApp needs for the `send` intent: where to pay, how much, and the ref
 * that ties the payment to this thread.
 */
app.post("/api/threads", requireAuth, (req, res) => {
  const me = req.user!;
  const { to, subject } = req.body ?? {};

  const target = typeof to === "string" ? to.trim() : "";
  if (!target) return bad(res, "Recipient is required");
  if (typeof subject !== "string" || subject.trim().length < 3) return bad(res, "Subject is too short");

  const recipient = PUBKEY.test(target) ? getUser(target) : getUserByHandle(target.replace(/^@/, ""));
  if (!recipient) return bad(res, "That inbox does not exist yet", 404);
  if (recipient.pubkey === me.pubkey) return bad(res, "You cannot pay to reach yourself");
  if (!recipient.is_open) return bad(res, "This inbox is closed", 403);
  if (isBlocked(recipient.pubkey, me.pubkey)) return bad(res, "You cannot reach this inbox", 403);

  const escrow = escrowAddress();
  if (!escrow) {
    return bad(
      res,
      "This server has no escrow address configured, so there is nowhere to pay. Set ESCROW_ADDRESS to a registered nametag or a DIRECT:// address (or run PAYOUT_MODE=sphere so the escrow wallet supplies its own).",
      503,
    );
  }

  const now = Date.now();
  const id = crypto.randomUUID();
  const ref = `pi_${crypto.randomBytes(6).toString("hex")}`;

  db.prepare(
    `INSERT INTO threads (id, ref, sender_pubkey, recipient_pubkey, subject, price_base, coin_id, state,
                          payout_policy, delivery_pending, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'PAYING', ?, 0, ?, ?)`,
  ).run(
    id,
    ref,
    me.pubkey,
    recipient.pubkey,
    subject.trim().slice(0, 140),
    recipient.price_base,
    env.coinId,
    env.payoutPolicy, // frozen onto the thread: a later settings change never rewrites this deal
    now,
    now,
  );

  logEvent(id, "created", { to: recipient.pubkey, price: recipient.price_base });

  res.json({
    thread: threadDto(getThread(id)!, me.pubkey),
    payment: {
      to: escrowAddress(),
      amount: recipient.price_base,
      coinId: env.coinId,
      memo: `paidinbox:${ref}`,
    },
    recipient: publicUser(recipient),
  });
});

/** Step 2. The wallet accepted the `send` intent. */
app.post("/api/threads/:id/paid", requireAuth, (req, res) => {
  const me = req.user!;
  const t = getThread(String(req.params.id));
  if (!t) return bad(res, "No such thread", 404);
  if (t.sender_pubkey !== me.pubkey) return bad(res, "Not your thread", 403);
  if (t.state !== "PAYING" && t.state !== "PENDING_RECONCILE") return bad(res, `Thread is already ${t.state}`, 409);

  const { transferId, deliveryPending } = req.body ?? {};
  const now = Date.now();

  db.prepare(
    `UPDATE threads SET state = 'ESCROWED', transfer_id = ?, delivery_pending = ?, updated_at = ? WHERE id = ?`,
  ).run(typeof transferId === "string" ? transferId : null, deliveryPending ? 1 : 0, now, t.id);

  db.prepare(
    `INSERT OR IGNORE INTO ledger (id, thread_id, kind, pubkey, amount_base, transfer_id, status, at)
     VALUES (?, ?, 'escrow_in', ?, ?, ?, 'settled', ?)`,
  ).run(
    crypto.randomUUID(),
    t.id,
    me.pubkey,
    t.price_base,
    typeof transferId === "string" ? transferId : null,
    now,
  );

  logEvent(t.id, "escrowed", { transferId, deliveryPending: !!deliveryPending });
  res.json({ thread: threadDto(getThread(t.id)!, me.pubkey) });
});

/**
 * Step 3. The DM went out from the sender's own wallet, end to end encrypted.
 * We record only the message id and a hash — never the body. The reply deadline
 * starts here, not at payment: the clock must not run while the message is in
 * flight.
 */
app.post("/api/threads/:id/delivered", requireAuth, (req, res) => {
  const me = req.user!;
  const t = getThread(String(req.params.id));
  if (!t) return bad(res, "No such thread", 404);
  if (t.sender_pubkey !== me.pubkey) return bad(res, "Not your thread", 403);
  if (t.state !== "ESCROWED") return bad(res, `Thread is ${t.state}, not ESCROWED`, 409);

  const { messageId, timestamp, bodyHash } = req.body ?? {};
  if (typeof messageId !== "string" || !messageId) return bad(res, "messageId is required");

  const recipient = getUser(t.recipient_pubkey)!;
  const at = Number(timestamp) || Date.now();
  const deadline = at + recipient.reply_window_hours * 3600_000;

  db.prepare(
    `UPDATE threads SET state = 'DELIVERED', message_id = ?, message_at = ?, body_hash = ?, deadline_at = ?, updated_at = ?
     WHERE id = ?`,
  ).run(messageId, at, typeof bodyHash === "string" ? bodyHash : null, deadline, Date.now(), t.id);

  logEvent(t.id, "delivered", { messageId, deadline });
  res.json({ thread: threadDto(getThread(t.id)!, me.pubkey) });
});

/** The 4201 path: the wallet took the intent and the answer was lost. */
app.post("/api/threads/:id/reconcile", requireAuth, (req, res) => {
  const me = req.user!;
  const t = getThread(String(req.params.id));
  if (!t) return bad(res, "No such thread", 404);
  if (t.sender_pubkey !== me.pubkey) return bad(res, "Not your thread", 403);
  if (t.state !== "PAYING") return bad(res, `Thread is ${t.state}`, 409);

  db.prepare("UPDATE threads SET state = 'PENDING_RECONCILE', updated_at = ? WHERE id = ?").run(Date.now(), t.id);
  logEvent(t.id, "pending_reconcile", { note: req.body?.note ?? null });
  res.json({ thread: threadDto(getThread(t.id)!, me.pubkey) });
});

/* ------------------------------------------------------------------ reply */

/**
 * The recipient proves a reply happened without us ever seeing the message.
 * We hand out a nonce; the wallet signs a statement binding thread + message id
 * + timestamp; we recover the pubkey and check it is the recipient's.
 */
app.post("/api/threads/:id/reply-challenge", requireAuth, (req, res) => {
  const me = req.user!;
  const t = getThread(String(req.params.id));
  if (!t) return bad(res, "No such thread", 404);
  if (t.recipient_pubkey !== me.pubkey) return bad(res, "Not your inbox", 403);
  if (t.state !== "DELIVERED") return bad(res, `Thread is ${t.state}, not DELIVERED`, 409);

  const { messageId, timestamp } = req.body ?? {};
  if (typeof messageId !== "string" || !messageId) return bad(res, "messageId is required");

  const nonce = crypto.randomBytes(12).toString("base64url");
  const at = Number(timestamp) || Date.now();

  const message = [
    "Paid Inbox — reply attestation",
    "",
    `Thread: ${t.id}`,
    `Ref: ${t.ref}`,
    `Reply message: ${messageId}`,
    `Replied at: ${new Date(at).toISOString()}`,
    `Nonce: ${nonce}`,
    "",
    "Signing releases the escrow according to the deal shown in the app.",
  ].join("\n");

  db.prepare("INSERT INTO nonces (nonce, pubkey, message, created_at, used) VALUES (?, ?, ?, ?, 0)").run(
    nonce,
    me.pubkey,
    message,
    Date.now(),
  );

  res.json({ nonce, message, messageId, timestamp: at });
});

app.post("/api/threads/:id/reply", requireAuth, (req, res) => {
  const me = req.user!;
  const t = getThread(String(req.params.id));
  if (!t) return bad(res, "No such thread", 404);
  if (t.recipient_pubkey !== me.pubkey) return bad(res, "Not your inbox", 403);
  if (t.state !== "DELIVERED") return bad(res, `Thread is ${t.state}, not DELIVERED`, 409);

  const { nonce, signature, replyLength } = req.body ?? {};
  if (typeof nonce !== "string" || typeof signature !== "string") return bad(res, "nonce and signature are required");

  const len = Number(replyLength ?? 0);
  if (!Number.isFinite(len) || len < env.minReplyChars) {
    return bad(res, `A reply must be at least ${env.minReplyChars} characters to release the escrow`);
  }

  const row = one<{ pubkey: string; message: string; used: number; created_at: number }>(
    "SELECT * FROM nonces WHERE nonce = ?",
    nonce,
  );

  if (!row || row.used) return bad(res, "Unknown or spent nonce", 401);
  if (row.pubkey !== me.pubkey) return bad(res, "Nonce belongs to another key", 401);
  if (Date.now() - row.created_at > 10 * 60_000) return bad(res, "Attestation expired — try again", 401);
  if (!verifyDetachedSignature(row.message, signature, me.pubkey)) {
    return bad(res, "Signature does not match your key", 401);
  }

  const messageId = /Reply message: (.+)/.exec(row.message)?.[1] ?? null;
  const now = Date.now();
  const confirmUntil = now + env.disputeWindowHours * 3600_000;

  db.prepare("UPDATE nonces SET used = 1 WHERE nonce = ?").run(nonce);
  db.prepare(
    `UPDATE threads SET state = 'REPLIED', reply_message_id = ?, reply_at = ?, reply_signature = ?,
            reply_attestation = ?, reply_len = ?, confirm_until = ?, updated_at = ?
     WHERE id = ?`,
  ).run(messageId, now, signature, row.message, Math.floor(len), confirmUntil, now, t.id);

  logEvent(t.id, "replied", { messageId, replyLength: Math.floor(len), confirmUntil });
  res.json({ thread: threadDto(getThread(t.id)!, me.pubkey) });
});

/* ---------------------------------------------------------------- dispute */

app.post("/api/threads/:id/dispute", requireAuth, (req, res) => {
  const me = req.user!;
  const t = getThread(String(req.params.id));
  if (!t) return bad(res, "No such thread", 404);
  if (t.sender_pubkey !== me.pubkey) return bad(res, "Only the sender can dispute", 403);
  if (t.state !== "REPLIED") return bad(res, `Thread is ${t.state}, not REPLIED`, 409);
  if (t.confirm_until && t.confirm_until <= Date.now()) return bad(res, "The dispute window has closed", 409);

  const reason = String(req.body?.reason ?? "").slice(0, 400);
  db.prepare("UPDATE threads SET state = 'DISPUTED', dispute_reason = ?, updated_at = ? WHERE id = ?").run(
    reason || null,
    Date.now(),
    t.id,
  );
  logEvent(t.id, "disputed", { reason });
  res.json({ thread: threadDto(getThread(t.id)!, me.pubkey) });
});

/* ------------------------------------------------------------------ lists */

app.get("/api/inbox", requireAuth, (req, res) => {
  const rows = db
    .prepare(
      `SELECT * FROM threads WHERE recipient_pubkey = ? AND state != 'PAYING'
        ORDER BY CASE state WHEN 'DELIVERED' THEN 0 WHEN 'REPLIED' THEN 1 ELSE 2 END,
                 CAST(SUBSTR('00000000000000000000000000000000' || price_base, -32) AS TEXT) DESC,
                 created_at DESC
        LIMIT 200`,
    )
    .all(req.user!.pubkey) as unknown as ThreadRow[];
  res.json({ threads: rows.map((t) => threadDto(t, req.user!.pubkey)) });
});

app.get("/api/sent", requireAuth, (req, res) => {
  const rows = db
    .prepare("SELECT * FROM threads WHERE sender_pubkey = ? ORDER BY created_at DESC LIMIT 200")
    .all(req.user!.pubkey) as unknown as ThreadRow[];
  res.json({ threads: rows.map((t) => threadDto(t, req.user!.pubkey)) });
});

app.get("/api/threads/:id", requireAuth, (req, res) => {
  const t = getThread(String(req.params.id));
  if (!t) return bad(res, "No such thread", 404);
  const me = req.user!.pubkey;
  if (t.sender_pubkey !== me && t.recipient_pubkey !== me) return bad(res, "Not your thread", 403);

  const events = db
    .prepare("SELECT type, detail, at FROM thread_events WHERE thread_id = ? ORDER BY id ASC")
    .all(t.id) as unknown as Array<{ type: string; detail: string | null; at: number }>;

  res.json({
    thread: threadDto(t, me),
    events: events.map((e) => ({ type: e.type, at: e.at, detail: e.detail ? JSON.parse(e.detail) : null })),
  });
});

/* ----------------------------------------------------------------- blocks */

app.post("/api/blocks", requireAuth, (req, res) => {
  const target = String(req.body?.pubkey ?? "");
  if (!PUBKEY.test(target)) return bad(res, "Invalid pubkey");
  db.prepare("INSERT OR IGNORE INTO blocks (owner_pubkey, blocked_pubkey, at) VALUES (?, ?, ?)").run(
    req.user!.pubkey,
    target,
    Date.now(),
  );
  res.json({ ok: true });
});

app.delete("/api/blocks/:pubkey", requireAuth, (req, res) => {
  db.prepare("DELETE FROM blocks WHERE owner_pubkey = ? AND blocked_pubkey = ?").run(
    req.user!.pubkey,
    String(req.params.pubkey),
  );
  res.json({ ok: true });
});

/* -------------------------------------------------------- transparency */

app.get("/api/reconciliation", async (_req, res) => {
  res.json(await reconcile());
});

app.get("/api/stats", (_req, res) => {
  const counts = db
    .prepare("SELECT state, COUNT(*) AS n FROM threads GROUP BY state")
    .all() as unknown as Array<{ state: string; n: number }>;

  const users = one<{ n: number }>("SELECT COUNT(*) AS n FROM users")?.n ?? 0;

  const volume = all<{ price_base: string }>("SELECT price_base FROM threads WHERE state != 'PAYING'").reduce((a, r) => a + BigInt(r.price_base), 0n);

  res.json({
    users,
    byState: Object.fromEntries(counts.map((c) => [c.state, c.n])),
    volumeBase: volume.toString(),
  });
});

/* ----------------------------------------------------------------- errors */

app.use((err: unknown, _req: Request, res: Response, _next: express.NextFunction) => {
  console.error("[api]", err);
  res.status(500).json({ error: "Internal error" });
});

/* ------------------------------------------------------------------- boot */

app.listen(env.port, async () => {
  console.log(`\n  Paid Inbox API   http://localhost:${env.port}`);
  console.log(`  payout rail      ${payoutRail.mode}${payoutRail.mode === "simulated" ? "  (no on-chain transfer)" : ""}`);
  console.log(`  payout policy    ${env.payoutPolicy}  (reply -> ${resolveOutcomeLabel()})`);
  console.log(`  fee              ${env.feeBps / 100}%`);
  console.log(`  demo signatures  ${env.allowDemo ? "allowed" : "refused"}`);

  // On the sphere rail the escrow wallet is the source of truth for its own
  // address; booting it here means the first sender does not pay that latency.
  if (payoutRail.mode === "sphere") {
    cachedRailAddress = await payoutRail.address();
  }

  const escrow = escrowAddress();
  console.log(`  escrow address   ${escrow ?? "NOT SET — senders cannot pay, see ESCROW_ADDRESS"}`);
  console.log(`  network          ${env.network}\n`);

  startSettlementLoop();
});

function resolveOutcomeLabel(): string {
  return env.payoutPolicy === "silence" ? "sender refunded" : "recipient earns";
}
