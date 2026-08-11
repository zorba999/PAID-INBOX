import { env } from "./env.js";

/* ==========================================================================
 * Storage
 *
 * One SQL dialect, two drivers:
 *   POSTGRES_URL set   -> `pg` against Vercel Postgres. This is production.
 *   POSTGRES_URL unset -> PGlite, real Postgres compiled to WASM, persisted to
 *                         ./data/pg. Local dev needs no service installed and
 *                         still exercises the exact SQL production runs.
 *
 * Amounts are TEXT holding base units. An 18-decimals coin passes 2^63 at 9.2
 * UCT, so nothing about a value ever becomes a number: no NUMERIC, no SUM(),
 * no arithmetic outside BigInt.
 *
 * Timestamps are BIGINT epoch ms. `pg` hands int8 back as a string and PGlite
 * as a number, so every read coerces with Number() rather than trusting either.
 * ========================================================================== */

type Param = string | number | bigint | null;

interface Driver {
  query<T>(sql: string, params: Param[]): Promise<T[]>;
  exec(sql: string): Promise<void>;
}

let driver: Driver | null = null;
let ready: Promise<Driver> | null = null;

async function createDriver(): Promise<Driver> {
  if (env.postgresUrl) {
    const { Pool } = await import("pg");
    // One connection per serverless invocation. A lambda serves one request at
    // a time, and a bigger pool just holds sockets the platform will reap.
    const pool = new Pool({
      connectionString: env.postgresUrl,
      max: 1,
      idleTimeoutMillis: 10_000,
      connectionTimeoutMillis: 10_000,
    });
    return {
      async query<T>(sql: string, params: Param[]): Promise<T[]> {
        const res = await pool.query(sql, params as unknown[]);
        return res.rows as T[];
      },
      async exec(sql: string): Promise<void> {
        await pool.query(sql);
      },
    };
  }

  const { PGlite } = await import("@electric-sql/pglite");

  // PGlite's node filesystem creates its data directory non-recursively, so a
  // fresh clone with no ./data yet fails on ENOENT before Postgres even starts.
  const { mkdirSync } = await import("node:fs");
  const { dirname } = await import("node:path");
  mkdirSync(dirname(env.localDataDir), { recursive: true });

  const pg = await PGlite.create({ dataDir: env.localDataDir });
  return {
    async query<T>(sql: string, params: Param[]): Promise<T[]> {
      const res = await pg.query(sql, params as unknown[]);
      return res.rows as T[];
    },
    async exec(sql: string): Promise<void> {
      await pg.exec(sql);
    },
  };
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  pubkey              TEXT PRIMARY KEY,
  handle              TEXT UNIQUE,
  display_name        TEXT,
  bio                 TEXT,
  price_base          TEXT   NOT NULL,
  reply_window_hours  INTEGER NOT NULL,
  is_open             INTEGER NOT NULL DEFAULT 1,
  created_at          BIGINT NOT NULL,
  updated_at          BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS nonces (
  nonce      TEXT PRIMARY KEY,
  pubkey     TEXT   NOT NULL,
  message    TEXT   NOT NULL,
  created_at BIGINT NOT NULL,
  used       INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS threads (
  id                     TEXT PRIMARY KEY,
  ref                    TEXT NOT NULL UNIQUE,
  sender_pubkey          TEXT NOT NULL,
  recipient_pubkey       TEXT NOT NULL,
  subject                TEXT NOT NULL,
  price_base             TEXT NOT NULL,
  coin_id                TEXT NOT NULL,
  state                  TEXT NOT NULL,
  payout_policy          TEXT NOT NULL,
  transfer_id            TEXT,
  delivery_pending       INTEGER NOT NULL DEFAULT 0,
  message_id             TEXT,
  message_at             BIGINT,
  body_hash              TEXT,
  reply_message_id       TEXT,
  reply_at               BIGINT,
  reply_signature        TEXT,
  reply_attestation      TEXT,
  reply_len              INTEGER,
  deadline_at            BIGINT,
  confirm_until          BIGINT,
  settled_at             BIGINT,
  settlement_transfer_id TEXT,
  fee_base               TEXT,
  payee_pubkey           TEXT,
  dispute_reason         TEXT,
  created_at             BIGINT NOT NULL,
  updated_at             BIGINT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_threads_recipient ON threads(recipient_pubkey, state);
CREATE INDEX IF NOT EXISTS idx_threads_sender    ON threads(sender_pubkey, state);
CREATE INDEX IF NOT EXISTS idx_threads_state     ON threads(state, deadline_at);

CREATE TABLE IF NOT EXISTS thread_events (
  id        SERIAL PRIMARY KEY,
  thread_id TEXT   NOT NULL,
  type      TEXT   NOT NULL,
  detail    TEXT,
  at        BIGINT NOT NULL
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
  at          BIGINT NOT NULL,
  UNIQUE (thread_id, kind)
);

CREATE TABLE IF NOT EXISTS blocks (
  owner_pubkey   TEXT NOT NULL,
  blocked_pubkey TEXT NOT NULL,
  at             BIGINT NOT NULL,
  PRIMARY KEY (owner_pubkey, blocked_pubkey)
);
`;

async function connect(): Promise<Driver> {
  if (driver) return driver;
  if (ready) return ready;

  ready = (async () => {
    const d = await createDriver();
    await d.exec(SCHEMA);
    driver = d;
    return d;
  })();

  try {
    return await ready;
  } finally {
    ready = null;
  }
}

/* ---------------------------------------------------------------- helpers */

export async function all<T>(sql: string, ...params: Param[]): Promise<T[]> {
  const d = await connect();
  return d.query<T>(sql, params);
}

export async function one<T>(sql: string, ...params: Param[]): Promise<T | undefined> {
  const rows = await all<T>(sql, ...params);
  return rows[0];
}

export async function run(sql: string, ...params: Param[]): Promise<void> {
  const d = await connect();
  await d.query(sql, params);
}

/** Warm the pool and apply the schema. Called once per cold start. */
export async function initDb(): Promise<void> {
  await connect();
}

/* ------------------------------------------------------------------ rows */

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

/** int8 arrives as a string from `pg` and a number from PGlite. Normalise. */
const num = (v: unknown): number | null =>
  v === null || v === undefined ? null : Number(v);

export function normalizeThread(r: ThreadRow): ThreadRow {
  return {
    ...r,
    message_at: num(r.message_at),
    reply_at: num(r.reply_at),
    deadline_at: num(r.deadline_at),
    confirm_until: num(r.confirm_until),
    settled_at: num(r.settled_at),
    created_at: num(r.created_at) ?? 0,
    updated_at: num(r.updated_at) ?? 0,
  };
}

export function normalizeUser(r: UserRow): UserRow {
  return { ...r, created_at: num(r.created_at) ?? 0, updated_at: num(r.updated_at) ?? 0 };
}

/* ------------------------------------------------------------------ query */

export async function logEvent(threadId: string, type: string, detail?: unknown): Promise<void> {
  await run(
    "INSERT INTO thread_events (thread_id, type, detail, at) VALUES ($1, $2, $3, $4)",
    threadId,
    type,
    detail === undefined ? null : JSON.stringify(detail),
    Date.now(),
  );
}

export async function getUser(pubkey: string): Promise<UserRow | undefined> {
  const r = await one<UserRow>("SELECT * FROM users WHERE pubkey = $1", pubkey);
  return r ? normalizeUser(r) : undefined;
}

export async function getUserByHandle(handle: string): Promise<UserRow | undefined> {
  const r = await one<UserRow>("SELECT * FROM users WHERE handle = $1", handle.toLowerCase());
  return r ? normalizeUser(r) : undefined;
}

export async function upsertUser(pubkey: string, handle: string | null): Promise<UserRow> {
  const existing = await getUser(pubkey);
  const now = Date.now();

  if (existing) {
    // A nametag can change hands. Keep the cached handle honest, but never let
    // a collision overwrite somebody else's row.
    if (handle && existing.handle !== handle) {
      const clash = await getUserByHandle(handle);
      if (!clash || clash.pubkey === pubkey) {
        await run("UPDATE users SET handle = $1, updated_at = $2 WHERE pubkey = $3", handle, now, pubkey);
      }
    }
    return (await getUser(pubkey))!;
  }

  const taken = handle ? await getUserByHandle(handle) : undefined;
  await run(
    `INSERT INTO users (pubkey, handle, display_name, bio, price_base, reply_window_hours, is_open, created_at, updated_at)
     VALUES ($1, $2, NULL, NULL, $3, $4, 1, $5, $6)
     ON CONFLICT (pubkey) DO NOTHING`,
    pubkey,
    handle && !taken ? handle : null,
    env.defaultPriceBase,
    env.defaultReplyWindowHours,
    now,
    now,
  );

  return (await getUser(pubkey))!;
}

export async function isBlocked(owner: string, other: string): Promise<boolean> {
  const row = await one<{ x: number }>(
    "SELECT 1 AS x FROM blocks WHERE owner_pubkey = $1 AND blocked_pubkey = $2",
    owner,
    other,
  );
  return !!row;
}

/** Reply rate and median response time, computed from concluded threads. */
export async function userStats(pubkey: string) {
  const rows = await all<{ state: string; message_at: number | null; reply_at: number | null }>(
    `SELECT state, message_at, reply_at FROM threads
      WHERE recipient_pubkey = $1
        AND state IN ('DELIVERED','REPLIED','RELEASED','EXPIRED','REFUNDED','DISPUTED')`,
    pubkey,
  );

  const answered = rows.filter((r) => r.reply_at !== null);
  const concluded = rows.filter(
    (r) => r.reply_at !== null || r.state === "EXPIRED" || r.state === "REFUNDED",
  );

  const deltas = answered
    .filter((r) => r.message_at)
    .map((r) => (Number(r.reply_at) - Number(r.message_at)) / 60000)
    .sort((a, b) => a - b);

  const earned = await all<{ amount_base: string }>(
    "SELECT amount_base FROM ledger WHERE pubkey = $1 AND kind = 'payout' AND status = 'settled'",
    pubkey,
  );

  return {
    received: rows.length,
    answered: answered.length,
    replyRate: concluded.length ? answered.length / concluded.length : null,
    medianReplyMinutes: deltas.length ? deltas[Math.floor(deltas.length / 2)] : null,
    totalEarnedBase: earned.reduce((acc, r) => acc + BigInt(r.amount_base), 0n).toString(),
  };
}
