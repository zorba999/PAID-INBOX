import { API_BASE, STORAGE } from "./config";

/* --------------------------------------------------------------------------
 * Backend client
 * ------------------------------------------------------------------------ */

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

let token: string | null = null;

export function setToken(next: string | null): void {
  token = next;
  try {
    if (next) localStorage.setItem(STORAGE.token, next);
    else localStorage.removeItem(STORAGE.token);
  } catch {
    /* private mode */
  }
}

export function loadToken(): string | null {
  if (token) return token;
  try {
    token = localStorage.getItem(STORAGE.token);
  } catch {
    token = null;
  }
  return token;
}

async function call<T>(
  path: string,
  opts: { method?: string; body?: unknown; auth?: boolean } = {},
): Promise<T> {
  const { method = "GET", body, auth = true } = opts;
  const t = auth ? loadToken() : null;

  const res = await fetch(`${API_BASE}${path}`, {
    method,
    headers: {
      "content-type": "application/json",
      ...(t ? { authorization: `Bearer ${t}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;

  if (!res.ok) {
    if (res.status === 401) setToken(null);
    throw new ApiError(String(json.error ?? `Request failed (${res.status})`), res.status);
  }
  return json as T;
}

/* ------------------------------------------------------------------ types */

export interface UserStats {
  received: number;
  answered: number;
  replyRate: number | null;
  medianReplyMinutes: number | null;
  totalEarnedBase: string;
}

export interface PublicUser {
  pubkey: string;
  handle: string | null;
  displayName: string | null;
  bio: string | null;
  priceBase: string;
  replyWindowHours: number;
  isOpen: boolean;
  stats: UserStats;
}

export type ThreadState =
  | "PAYING"
  | "PENDING_RECONCILE"
  | "ESCROWED"
  | "DELIVERED"
  | "REPLIED"
  | "RELEASED"
  | "EXPIRED"
  | "REFUNDED"
  | "DISPUTED";

export interface Thread {
  id: string;
  ref: string;
  subject: string;
  state: ThreadState;
  priceBase: string;
  coinId: string;
  feeBase: string;
  netBase: string;
  payoutPolicy: "reply" | "silence";
  role: "sender" | "recipient";
  sender: { pubkey: string; handle: string | null };
  recipient: { pubkey: string; handle: string | null };
  transferId: string | null;
  deliveryPending: boolean;
  messageId: string | null;
  messageAt: number | null;
  replyMessageId: string | null;
  replyAt: number | null;
  deadlineAt: number | null;
  confirmUntil: number | null;
  settledAt: number | null;
  payeePubkey: string | null;
  disputeReason: string | null;
  createdAt: number;
  outcomeIfSilent: "recipient" | "sender";
  outcomeIfReplied: "recipient" | "sender";
}

export interface ThreadEvent {
  type: string;
  at: number;
  detail: Record<string, unknown> | null;
}

export interface AppConfig {
  coinId: string;
  coinSymbol: string;
  coinDecimals: number;
  feeBps: number;
  payoutPolicy: "reply" | "silence";
  minPriceBase: string;
  maxPriceBase: string;
  disputeWindowHours: number;
  minReplyChars: number;
  escrowAddress: string | null;
  /** False when the server has nowhere for senders to pay — compose is blocked. */
  escrowConfigured: boolean;
  payoutMode: "simulated" | "sphere";
  allowDemo: boolean;
  network: string;
}

export interface Reconciliation {
  mode: string;
  coinId: string;
  openEscrowBase: string;
  feesEarnedBase: string;
  paidOutBase: string;
  escrowInBase: string;
  expectedFloatBase: string;
  actualFloatBase: string | null;
  balanced: boolean | null;
  checkedAt: number;
}

export interface PaymentInstructions {
  to: string;
  amount: string;
  coinId: string;
  memo: string;
}

/* ------------------------------------------------------------------- api */

export const api = {
  config: () => call<AppConfig>("/api/config", { auth: false }),
  stats: () => call<{ users: number; byState: Record<string, number>; volumeBase: string }>("/api/stats", { auth: false }),
  reconciliation: () => call<Reconciliation>("/api/reconciliation", { auth: false }),
  directory: () => call<{ users: PublicUser[] }>("/api/directory", { auth: false }),
  profile: (handle: string) => call<{ user: PublicUser }>(`/api/u/${encodeURIComponent(handle)}`, { auth: false }),

  nonce: (pubkey: string) =>
    call<{ nonce: string; message: string }>("/api/auth/nonce", { method: "POST", body: { pubkey }, auth: false }),

  verify: (payload: { pubkey: string; nonce: string; signature: string; nametag?: string | null }) =>
    call<{ token: string; user: PublicUser; demo: boolean }>("/api/auth/verify", {
      method: "POST",
      body: payload,
      auth: false,
    }),

  me: () => call<{ user: PublicUser; demo: boolean }>("/api/me"),

  updateMe: (patch: Partial<{
    displayName: string;
    bio: string;
    priceBase: string;
    replyWindowHours: number;
    isOpen: boolean;
    handle: string;
  }>) => call<{ user: PublicUser }>("/api/me", { method: "PATCH", body: patch }),

  createThread: (body: { to: string; subject: string }) =>
    call<{ thread: Thread; payment: PaymentInstructions; recipient: PublicUser }>("/api/threads", {
      method: "POST",
      body,
    }),

  markPaid: (id: string, body: { transferId?: string | null; deliveryPending?: boolean }) =>
    call<{ thread: Thread }>(`/api/threads/${id}/paid`, { method: "POST", body }),

  markDelivered: (id: string, body: { messageId: string; timestamp?: number; bodyHash?: string }) =>
    call<{ thread: Thread }>(`/api/threads/${id}/delivered`, { method: "POST", body }),

  markReconcile: (id: string, note?: string) =>
    call<{ thread: Thread }>(`/api/threads/${id}/reconcile`, { method: "POST", body: { note } }),

  replyChallenge: (id: string, body: { messageId: string; timestamp?: number }) =>
    call<{ nonce: string; message: string; messageId: string; timestamp: number }>(
      `/api/threads/${id}/reply-challenge`,
      { method: "POST", body },
    ),

  submitReply: (id: string, body: { nonce: string; signature: string; replyLength: number }) =>
    call<{ thread: Thread }>(`/api/threads/${id}/reply`, { method: "POST", body }),

  dispute: (id: string, reason: string) =>
    call<{ thread: Thread }>(`/api/threads/${id}/dispute`, { method: "POST", body: { reason } }),

  inbox: () => call<{ threads: Thread[] }>("/api/inbox"),
  sent: () => call<{ threads: Thread[] }>("/api/sent"),
  thread: (id: string) => call<{ thread: Thread; events: ThreadEvent[] }>(`/api/threads/${id}`),

  block: (pubkey: string) => call<{ ok: true }>("/api/blocks", { method: "POST", body: { pubkey } }),
  unblock: (pubkey: string) => call<{ ok: true }>(`/api/blocks/${pubkey}`, { method: "DELETE" }),
};
