import { ERROR_CODES } from "@unicitylabs/sphere-sdk/connect";

/**
 * Error handling for Sphere Connect.
 *
 * Rule 1: discriminate on the numeric `.code`, never on message text — the text
 *         is a documented recommendation, not a wire contract.
 * Rule 2: a handful of SDK failures carry no code at all. Keep a NARROW message
 *         fallback for exactly those, and never match on "session" or "closed".
 */

export function errorCode(err: unknown): number | undefined {
  if (typeof err === "object" && err !== null && "code" in err) {
    const c = (err as { code: unknown }).code;
    if (typeof c === "number") return c;
  }
  return undefined;
}

export function errorData(err: unknown): Record<string, unknown> | undefined {
  if (typeof err === "object" && err !== null && "data" in err) {
    const d = (err as { data: unknown }).data;
    if (typeof d === "object" && d !== null) return d as Record<string, unknown>;
  }
  return undefined;
}

const CODELESS_TEARDOWN = [
  "Not connected",
  "Query timeout",
  "Intent timeout",
  "Connection timeout",
  "Disconnected",
];

export type RequestFailure =
  | "outcome-unknown" // 4201 — DO NOT retry, reconcile first
  | "locked" // 4009 — session alive, retry after unlock
  | "teardown" // the session really is gone
  | "rejected" // user declined; safe to offer again
  | "other";

export function classifyRequestError(err: unknown): RequestFailure {
  const code = errorCode(err);

  if (code === ERROR_CODES.INTENT_OUTCOME_UNKNOWN) return "outcome-unknown";
  if (code === ERROR_CODES.WALLET_LOCKED) return "locked";
  if (code === ERROR_CODES.NOT_CONNECTED || code === ERROR_CODES.SESSION_EXPIRED) return "teardown";
  if (code === ERROR_CODES.USER_REJECTED || code === ERROR_CODES.INTENT_CANCELLED) return "rejected";
  if (code !== undefined) return "other";

  // Codeless SDK failures — the narrow fallback.
  const msg = err instanceof Error ? err.message : String(err ?? "");
  if (CODELESS_TEARDOWN.some((m) => msg.includes(m))) return "teardown";

  return "other";
}

/** Human copy. For 4007 we surface the actual version numbers from `data`. */
export function describeConnectFailure(err: unknown): string {
  const code = errorCode(err);
  const data = errorData(err);

  switch (code) {
    case ERROR_CODES.UNSUPPORTED_PROTOCOL_VERSION: {
      const required = data?.requiredSdk ?? "a newer version";
      const actual = data?.actualSdk ?? "unknown (not reported)";
      return `Wallet needs sphere-sdk ${required}; this dApp reports ${actual}. Bump the dependency and rebuild.`;
    }
    case ERROR_CODES.INCOMPATIBLE_NETWORK:
      return "This dApp targets testnet2 and your wallet is on another network.";
    case ERROR_CODES.USER_REJECTED:
      return "You declined the connection.";
    case ERROR_CODES.ORIGIN_BLOCKED:
      return "The wallet has blocked this origin.";
    case ERROR_CODES.RATE_LIMITED:
      return "Too many requests — slow down for a moment.";
    case ERROR_CODES.WALLET_LOCKED:
      return "Your wallet is locked. Unlock it in Sphere, then try again.";
    case ERROR_CODES.INSUFFICIENT_BALANCE:
      return "Not enough balance for this transfer.";
    case ERROR_CODES.INVALID_RECIPIENT:
      return "The wallet could not resolve that recipient.";
    case ERROR_CODES.TRANSFER_FAILED:
      return "The transfer failed. Nothing was sent.";
    case ERROR_CODES.INTENT_OUTCOME_UNKNOWN:
      return "The wallet lost track of the answer. The payment may or may not have gone through — we are reconciling. Do not send again.";
    case ERROR_CODES.PERMISSION_DENIED:
      return "The wallet did not grant a permission this action needs.";
    default: {
      const msg = err instanceof Error ? err.message : String(err ?? "");
      if (msg.includes("Popup blocked")) {
        return "Your browser blocked the wallet popup. Allow popups for this site and retry.";
      }
      if (msg.includes("Connection rejected by wallet")) {
        // Cold-start-locked hosts refuse the handshake with no code at all.
        return "The wallet is not ready yet (it may be locked). Unlock Sphere and try again.";
      }
      return msg || "Something went wrong talking to the wallet.";
    }
  }
}
