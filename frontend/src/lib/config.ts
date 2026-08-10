import { PERMISSION_SCOPES, type PermissionScope } from "@unicitylabs/sphere-sdk/connect";

/* --------------------------------------------------------------------------
 * Network + coin
 * testnet2 is the only live v2 network and the only one that allows self-mint,
 * which is how a tester funds a fresh wallet without a faucet.
 * ------------------------------------------------------------------------ */

export const NETWORK = { id: 4, name: "testnet2" } as const;

/** Canonical lowercase 64-hex coin id. A symbol like "UCT" is rejected by the wallet. */
export const COIN = {
  id: "f581d30f593e4b369d684a4563b5246f07b1d265f7178a2c0a82b81f39c24dc0",
  symbol: "UCT",
  decimals: 18,
} as const;

/* --------------------------------------------------------------------------
 * dApp identity shown inside the wallet's approval sheet
 * ------------------------------------------------------------------------ */

export const DAPP = {
  name: "Paid Inbox",
  description: "Attention has a price. Pay to reach an inbox, earn by replying.",
  url: typeof location !== "undefined" ? location.origin : "https://paidinbox.app",
} as const;

/* --------------------------------------------------------------------------
 * Permission scopes.
 *
 * Requested at handshake and shown to the user one by one, so we ask for the
 * minimum the product actually uses — an over-broad request is the fastest way
 * to lose a connect. `identity:read` is always granted.
 * ------------------------------------------------------------------------ */

export const REQUIRED_SCOPES: PermissionScope[] = [
  PERMISSION_SCOPES.IDENTITY_READ, // who is connected -> our primary key
  PERMISSION_SCOPES.SIGN_REQUEST, // login + reply attestation
  PERMISSION_SCOPES.TRANSFER_REQUEST, // sender funds the escrow
  PERMISSION_SCOPES.DM_REQUEST, // send the message / the reply
  PERMISSION_SCOPES.DM_READ, // render the thread client-side
  PERMISSION_SCOPES.DM_MANAGE, // mark read
  PERMISSION_SCOPES.RESOLVE_PEER, // @nametag -> address
  PERMISSION_SCOPES.EVENTS_SUBSCRIBE, // live transfer events
  PERMISSION_SCOPES.BALANCE_READ, // earnings dashboard
  PERMISSION_SCOPES.HISTORY_READ, // earnings dashboard
];

/* --------------------------------------------------------------------------
 * Endpoints
 * ------------------------------------------------------------------------ */

export const API_BASE = (import.meta.env.VITE_API_BASE as string) || "http://localhost:8787";

/** Wallet URL used for the P3 popup fallback. */
export const WALLET_URL =
  (import.meta.env.VITE_WALLET_URL as string) || "https://sphere.unicity.network";

/* --------------------------------------------------------------------------
 * Storage keys
 * ------------------------------------------------------------------------ */

export const STORAGE = {
  popupSession: "paidinbox:popup-session",
  theme: "paidinbox:theme",
  token: "paidinbox:token",
  demo: "paidinbox:demo",
} as const;

/** Subscribable wallet events this dApp listens to (post-0.14 names). */
export const SUBSCRIBED_EVENTS = [
  "transfer:incoming",
  "transfer:updated",
  "transfer:attention",
  "connection:status",
] as const;
