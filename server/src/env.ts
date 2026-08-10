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

export const env = {
  port: num("PORT", 8787),
  origin: process.env.CORS_ORIGIN ?? "*",
  dbFile: process.env.DB_FILE ?? "./data/paidinbox.db",

  /** HMAC secret for session tokens. Generated per-boot if unset (dev only). */
  authSecret: process.env.AUTH_SECRET ?? crypto.randomBytes(32).toString("hex"),
  tokenTtlMs: num("TOKEN_TTL_MS", 7 * 24 * 60 * 60 * 1000),

  /* ---- economics ---- */

  coinId: (process.env.COIN_ID ?? "f581d30f593e4b369d684a4563b5246f07b1d265f7178a2c0a82b81f39c24dc0").toLowerCase(),
  coinDecimals: num("COIN_DECIMALS", 18),
  coinSymbol: process.env.COIN_SYMBOL ?? "UCT",

  /** Platform cut on a released escrow, in basis points. 500 = 5%. */
  feeBps: num("FEE_BPS", 500),

  /** Guard rails on what a recipient may charge, in base units. */
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
   *  'reply'   — recipient earns by replying, silence refunds the sender.  (default)
   *  'silence' — the inverted rule: silence pays the recipient.
   * The inverted rule rewards ignoring the message, so it is not the default.
   */
  payoutPolicy: (process.env.PAYOUT_POLICY === "silence" ? "silence" : "reply") as "reply" | "silence",

  /* ---- escrow rail ---- */

  /**
   * 'simulated' — the state machine, ledger and reconciliation are real; the
   *               on-chain transfer is journalled but not broadcast. No keys needed.
   * 'sphere'    — a real bot wallet settles on testnet2. Requires BOT_MNEMONIC
   *               and WALLET_API_URL.
   */
  payoutMode: (process.env.PAYOUT_MODE === "sphere" ? "sphere" : "simulated") as "simulated" | "sphere",
  botMnemonic: process.env.BOT_MNEMONIC ?? "",
  botNametag: process.env.BOT_NAMETAG ?? "@paidinbox-escrow",
  walletApiUrl: process.env.WALLET_API_URL ?? "",
  network: process.env.NETWORK ?? "testnet2",

  /** Accept demo-mode signatures. Turn OFF in production. */
  allowDemo: bool("ALLOW_DEMO", true),

  settlementIntervalMs: num("SETTLEMENT_INTERVAL_MS", 15_000),
} as const;

export const isProd = process.env.NODE_ENV === "production";

if (isProd && !process.env.AUTH_SECRET) {
  throw new Error("AUTH_SECRET must be set in production — a per-boot secret invalidates every session on restart.");
}
if (isProd && env.allowDemo) {
  throw new Error("ALLOW_DEMO must be 0 in production — demo signatures are not cryptographic proof.");
}
