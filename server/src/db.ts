import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
import { env } from "./env.js";

const dir = path.dirname(env.dbFile);
if (dir && dir !== "." && !fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

export const db = new DatabaseSync(env.dbFile);

db.exec("PRAGMA journal_mode = WAL;");
db.exec("PRAGMA foreign_keys = ON;");

/* ==========================================================================
 * Schema
 *
 * Amounts are TEXT holding base units. SQLite integers top out at 2^63 and an
 * 18-decimals coin blows past that at 9.2 UCT — every amount stays a string,
 * end to end, and arithmetic happens in BigInt.
 * ========================================================================== */

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  pubkey              TEXT PRIMARY KEY,
  handle              TEXT UNIQUE,
  display_name        TEXT,
  bio                 TEXT,
  price_base          TEXT NOT NULL,
  reply_window_hours  INTEGER NOT NULL,
  is_open             INTEGER NOT NULL DEFAULT 1,
  created_at          INTEGER NOT NULL,
  updated_at          INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS nonces (
  nonce      TEXT PRIMARY KEY,
  pubkey     TEXT NOT NULL,
  message    TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  used       INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS threads (
  id                    TEXT PRIMARY KEY,
  ref                   TEXT NOT NULL UNIQUE,
  sender_pubkey         TEXT NOT NULL,
  recipient_pubkey      TEXT NOT NULL,
  subject               TEXT NOT NULL,
  price_base            TEXT NOT NULL,
  coin_id               TEXT NOT NULL,
  state                 TEXT NOT NULL,
  payout_policy         TEXT NOT NULL,

  transfer_id           TEXT,
  delivery_pending      INTEGER NOT NULL DEFAULT 0,

  message_id            TEXT,
  message_at            INTEGER,
  body_hash             TEXT,

  reply_message_id      TEXT,
  reply_at              INTEGER,
  reply_signature       TEXT,
  reply_attestation     TEXT,
  reply_len             INTEGER,

  deadline_at           INTEGER,
  confirm_until         INTEGER,

  settled_at            INTEGER,
  settlement_transfer_id TEXT,
  fee_base              TEXT,
  payee_pubkey          TEXT,

  dispute_reason        TEXT,
  created_at            INTEGER NOT NULL,
  updated_at            INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_threads_recipient ON threads(recipient_pubkey, state);
CREATE INDEX IF NOT EXISTS idx_threads_sender    ON threads(sender_pubkey, state);
CREATE INDEX IF NOT EXISTS idx_threads_state     ON threads(state, deadline_at);

CREATE TABLE IF NOT EXISTS thread_events (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  thread_id TEXT NOT NULL,
  type      TEXT NOT NULL,
  detail    TEXT,
  at        INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_events_thread ON thread_events(thread_id, id);

CREATE TABLE IF NOT EXISTS ledger (
  id          TEXT PRIMARY KEY,
  thread_id   TEXT NOT NULL,
  kind        TEXT NOT NULL,
  pubkey      TEXT NOT NULL,
  amount_base TEXT NOT NULL,
  transfer_id TEXT,
  status      TEXT NOT NULL,
  at          INTEGER NOT NULL,
  UNIQUE(thread_id, kind)
);

CREATE TABLE IF NOT EXISTS blocks (
  owner_pubkey   TEXT NOT NULL,
  blocked_pubkey TEXT NOT NULL,
  at             INTEGER NOT NULL,
  PRIMARY KEY (owner_pubkey, blocked_pubkey)
);
`);

/* ---------------------------------------------------------------- helpers
 * node:sqlite hands back `Record<string, SQLOutputValue>`. These three wrappers
 * are the only place that shape is narrowed, so every call site stays typed
 * without an `as` cast of its own.
 * ------------------------------------------------------------------------ */

type Param = string | number | bigint | null | Uint8Array;

export function all<T>(sql: string, ...params: Param[]): T[] {
  return db.prepare(sql).all(...params) as unknown as T[];
}

export function one<T>(sql: string, ...params: Param[]): T | undefined {
  return db.prepare(sql).get(...params) as unknown as T | undefined;
}

export function run(sql: string, ...params: Param[]): void {
  db.prepare(sql).run(...params);
}

export interface UserRow {
  pubkey: string;
  handle: string | null;
  display_name: string | null;
  bio: string | null;
  price_base: string;
  reply_window_hours: number;
  is_open: number;
  created_at: number;
  updated_at: number;
}

export interface ThreadRow {
  id: string;
  ref: string;
  sender_pubkey: string;
  recipient_pubkey: string;
  subject: string;
  price_base: string;
  coin_id: string;
  state: string;
  payout_policy: string;
  transfer_id: string | null;
  delivery_pending: number;
  message_id: string | null;
  message_at: number | null;
  body_hash: string | null;
  reply_message_id: string | null;
  reply_at: number | null;
  reply_signature: string | null;
  reply_attestation: string | null;
  reply_len: number | null;
  deadline_at: number | null;
  confirm_until: number | null;
  settled_at: number | null;
  settlement_transfer_id: string | null;
  fee_base: string | null;
  payee_pubkey: string | null;
  dispute_reason: string | null;
  created_at: number;
  updated_at: number;
}

export function logEvent(threadId: string, type: string, detail?: unknown): void {
  db.prepare("INSERT INTO thread_events (thread_id, type, detail, at) VALUES (?, ?, ?, ?)").run(
    threadId,
    type,
    detail === undefined ? null : JSON.stringify(detail),
    Date.now(),
  );
}

export function getUser(pubkey: string): UserRow | undefined {
  return one<UserRow>("SELECT * FROM users WHERE pubkey = ?", pubkey);
}

export function getUserByHandle(handle: string): UserRow | undefined {
  return one<UserRow>("SELECT * FROM users WHERE handle = ?", handle.toLowerCase());
}

export function upsertUser(pubkey: string, handle: string | null): UserRow {
  const existing = getUser(pubkey);
  const now = Date.now();

  if (existing) {
    // A nametag can change hands; keep the cached handle honest but never let a
    // collision wipe out somebody else's row.
    if (handle && existing.handle !== handle) {
      const clash = getUserByHandle(handle);
      if (!clash || clash.pubkey === pubkey) {
        db.prepare("UPDATE users SET handle = ?, updated_at = ? WHERE pubkey = ?").run(handle, now, pubkey);
      }
    }
    return getUser(pubkey)!;
  }

  const safeHandle = handle && !getUserByHandle(handle) ? handle : null;
  db.prepare(
    `INSERT INTO users (pubkey, handle, display_name, bio, price_base, reply_window_hours, is_open, created_at, updated_at)
     VALUES (?, ?, NULL, NULL, ?, ?, 1, ?, ?)`,
  ).run(pubkey, safeHandle, env.defaultPriceBase, env.defaultReplyWindowHours, now, now);

  return getUser(pubkey)!;
}

export function isBlocked(owner: string, other: string): boolean {
  return !!one<{ x: number }>("SELECT 1 AS x FROM blocks WHERE owner_pubkey = ? AND blocked_pubkey = ?", owner, other);
}

/** Reply rate / median response time, computed from settled history. */
export function userStats(pubkey: string) {
  const rows = all<{ state: string; message_at: number | null; reply_at: number | null }>(
    `SELECT state, message_at, reply_at FROM threads
       WHERE recipient_pubkey = ? AND state IN ('DELIVERED','REPLIED','RELEASED','EXPIRED','REFUNDED','DISPUTED')`,
    pubkey,
  );

  const answered = rows.filter((r) => r.reply_at !== null);
  const concluded = rows.filter((r) => r.reply_at !== null || r.state === "EXPIRED" || r.state === "REFUNDED");

  const deltas = answered
    .filter((r) => r.message_at)
    .map((r) => (r.reply_at! - r.message_at!) / 60000)
    .sort((a, b) => a - b);

  const median = deltas.length ? deltas[Math.floor(deltas.length / 2)] : null;

  const earned = all<{ amount_base: string }>(
    "SELECT amount_base FROM ledger WHERE pubkey = ? AND kind = 'payout' AND status = 'settled'",
    pubkey,
  );

  return {
    received: rows.length,
    answered: answered.length,
    replyRate: concluded.length ? answered.length / concluded.length : null,
    medianReplyMinutes: median,
    totalEarnedBase: earned.reduce((acc, r) => acc + BigInt(r.amount_base), 0n).toString(),
  };
}
