import "dotenv/config";
import crypto from "node:crypto";

function num(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

function bool(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  return raw === "1" || raw.toLowerCase() === "true";
}

/**
 * On Vercel, NODE_ENV is "production" for every deployment including previews,
 * and VERCEL_ENV distinguishes them. Treat only a real production deployment as
 * production so a preview can still run with demo signatures on.
 */
const vercelEnv = process.env.VERCEL_ENV;
export const isProd = vercelEnv ? vercelEnv === "production" : process.env.NODE_ENV === "production";

export const env = {
  port: num("PORT", 8787),
  origin: process.env.CORS_ORIGIN ?? "*",

  /**
   * Vercel Postgres sets POSTGRES_URL automatically once the store is attached.
   * Without it the app falls back to PGlite on disk, which is local dev only:
   * a serverless filesystem does not survive the invocation.
   */
  postgresUrl: process.env.POSTGRES_URL ?? process.env.DATABASE_URL ?? "",
  localDataDir: process.env.LOCAL_DATA_DIR ?? "./data/pg",

  /** HMAC secret for session tokens. Generated per-boot if unset (dev only). */
  authSecret: process.env.AUTH_SECRET ?? crypto.randomBytes(32).toString("hex"),
  tokenTtlMs: num("TOKEN_TTL_MS", 7 * 24 * 60 * 60 * 1000),

  /* ---- economics ---- */

  coinId: (
    process.env.COIN_ID ?? "f581d30f593e4b369d684a4563b5246f07b1d265f7178a2c0a82b81f39c24dc0"
  ).toLowerCase(),
  coinDecimals: num("COIN_DECIMALS", 18),
  coinSymbol: process.env.COIN_SYMBOL ?? "UCT",

  /** Platform cut on a released escrow, in basis points. 500 = 5%. */
  feeBps: num("FEE_BPS", 500),

  minPriceBase: process.env.MIN_PRICE_BASE ?? "100000000000000000", // 0.1 UCT
  maxPriceBase: process.env.MAX_PRICE_BASE ?? "50000000000000000000", // 50 UCT

  defaultPriceBase: process.env.DEFAULT_PRICE_BASE ?? "1000000000000000000", // 1 UCT
  defaultReplyWindowHours: num("DEFAULT_REPLY_WINDOW_HOURS", 72),

  /** How long the sender has to dispute a reply before the payout fires. */
  disputeWindowHours: num("DISPUTE_WINDOW_HOURS", 24),

  /** Minimum characters for a reply to count. Cheap defence against "ok". */
  minReplyChars: num("MIN_REPLY_CHARS", 80),

  /**
   * Who the escrow pays when the recipient REPLIES.
   *  'reply'   - recipient earns by replying, silence refunds the sender.  (default)
   *  'silence' - the inverted rule: silence pays the recipient.
   * The inverted rule rewards ignoring the message, so it is not the default.
   */
  payoutPolicy: (process.env.PAYOUT_POLICY === "silence" ? "silence" : "reply") as "reply" | "silence",

  /* ---- escrow ---- */

  /**
   * Where senders pay. MUST be an address the network can resolve: a nametag
   * you registered, or a DIRECT:// address. The wallet answers
   * INVALID_RECIPIENT (4101) for anything else, inside the wallet, where the
   * error helps nobody.
   */
  escrowAddress: process.env.ESCROW_ADDRESS ?? "",

  payoutMode: (process.env.PAYOUT_MODE === "sphere" ? "sphere" : "simulated") as "simulated" | "sphere",
  escrowMnemonic: process.env.ESCROW_MNEMONIC ?? "",
  escrowDataDir: process.env.ESCROW_DATA_DIR ?? "./data/escrow-wallet",
  escrowDeviceId: process.env.ESCROW_DEVICE_ID ?? "paid-inbox-escrow",

  walletApiUrl: process.env.WALLET_API_URL ?? "https://wallet-api.unicity.network",
  aggregatorApiKey: process.env.AGGREGATOR_API_KEY ?? "",
  network: process.env.NETWORK ?? "testnet2",

  /**
   * Accept demo-mode signatures. A demo signature is a hash of the challenge
   * and a PUBLIC key, so anyone can mint one for any account: with this on, a
   * public deployment lets anybody sign in as anybody.
   */
  allowDemo: bool("ALLOW_DEMO", !isProd),

  /**
   * Serverless has no long-lived process, so the settlement worker cannot be a
   * timer. It runs opportunistically on API traffic, at most this often, and a
   * cron endpoint covers a site with no traffic at all.
   */
  settlementMinIntervalMs: num("SETTLEMENT_MIN_INTERVAL_MS", 20_000),

  /** Optional shared secret for /api/cron/settle. Vercel Cron sends it as a bearer. */
  cronSecret: process.env.CRON_SECRET ?? "",
} as const;

if (isProd && !process.env.AUTH_SECRET) {
  throw new Error(
    "AUTH_SECRET must be set in production. Without it a per-boot secret is generated, " +
      "and on serverless that means every cold start silently invalidates every session.",
  );
}
if (isProd && env.allowDemo) {
  throw new Error(
    "ALLOW_DEMO must be 0 in production. A demo signature is a hash of the challenge and a " +
      "public key, so leaving it on lets anyone authenticate as any account.",
  );
}
if (isProd && !env.postgresUrl) {
  throw new Error(
    "POSTGRES_URL must be set in production. The PGlite fallback writes to the local " +
      "filesystem, which a serverless invocation does not keep.",
  );
}
