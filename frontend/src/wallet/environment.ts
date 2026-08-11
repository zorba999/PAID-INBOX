import { hasExtension, isInIframe } from "@unicitylabs/sphere-sdk/connect/browser";
import { WALLET_URL } from "../lib/config";

/* ==========================================================================
 * Which Connect path is available in this browser.
 *
 * Read this only AFTER a connect has failed, never to warn ahead of time:
 * `hasExtension()` reads a flag the extension injects asynchronously, so on a
 * cold page load it can still be false while the extension is present and
 * about to work perfectly. A pre-emptive warning built on it fires on setups
 * that have nothing wrong with them.
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
