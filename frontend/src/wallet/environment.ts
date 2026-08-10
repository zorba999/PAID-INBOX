import { hasExtension, isInIframe } from "@unicitylabs/sphere-sdk/connect/browser";
import { WALLET_URL } from "../lib/config";

/* ==========================================================================
 * Which Connect path is actually available in this browser, right now.
 *
 * This mirrors the priority `autoConnect` uses internally, but we need it
 * BEFORE connecting: the popup path (P3) is refused by the hosted wallet with
 * a CloudFront 403, so opening a popup there only shows the user an error page
 * they cannot act on. Better to say so up front.
 * ======================================================================== */

export type ConnectPath = "iframe" | "extension" | "popup";

export function detectConnectPath(): ConnectPath {
  if (isInIframe()) return "iframe";
  if (hasExtension()) return "extension";
  return "popup";
}

/** True when we would be popping up against a wallet that refuses popups. */
export function isHostedWallet(url: string = WALLET_URL): boolean {
  try {
    const host = new URL(url).hostname;
    return host.endsWith("unicity.network");
  } catch {
    return false;
  }
}

/**
 * The popup path against the hosted wallet is a dead end — `/connect?origin=…`
 * answers 403 at the CDN before the wallet is ever reached. Only a locally run
 * wallet serves it.
 */
export function popupPathIsBlocked(): boolean {
  return detectConnectPath() === "popup" && isHostedWallet();
}

export const CUSTOM_AGENT_URL = `${WALLET_URL.replace(/\/$/, "")}/agents/custom`;
export const EXTENSION_RELEASES_URL = "https://github.com/unicity-sphere/sphere-extension/releases";
