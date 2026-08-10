/* ==========================================================================
 * DEMO WALLET HOST
 *
 * A simulated Sphere wallet that speaks the real Sphere Connect wire protocol
 * over an in-memory transport. It exists so the dApp can be run and reviewed
 * end-to-end without installing a wallet.
 *
 * Important: the dApp code path is IDENTICAL in demo and in production — the
 * same `ConnectClient`, the same handshake, the same queries/intents/events,
 * the same error codes. Only the thing on the far side of the transport is
 * simulated, and it is labelled as such everywhere in the UI.
 *
 * No real money moves in demo mode. Ever.
 * ======================================================================== */

import {
  ERROR_CODES,
  RPC_METHODS,
  INTENT_ACTIONS,
  SPHERE_CONNECT_NAMESPACE,
  SPHERE_CONNECT_VERSION,
  WALLET_EVENTS,
  type ConnectTransport,
  type SphereConnectMessage,
} from "@unicitylabs/sphere-sdk/connect";
import { COIN, NETWORK } from "../lib/config";

/* ------------------------------------------------------------------ state */

const DEMO_KEY = "paidinbox:demo-wallet";

export interface DemoWalletState {
  chainPubkey: string;
  directAddress: string;
  nametag: string;
  /** base units */
  balance: string;
  locked: boolean;
  history: Array<{
    id: string;
    direction: "in" | "out";
    counterparty: string;
    amount: string;
    coinId: string;
    memo?: string;
    at: number;
  }>;
  messages: Array<{
    id: string;
    peer: string;
    fromMe: boolean;
    body: string;
    at: number;
    read: boolean;
  }>;
}

function randHex(n: number): string {
  const bytes = new Uint8Array(n);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Demo-only: map a nametag (or a pubkey) to a stable conversation key.
 *
 * A real wallet resolves a nametag through the network and files the DM under
 * the peer's real pubkey. The demo wallet has no network, so it derives one
 * deterministically instead — the dApp uses the same helper when it reads the
 * thread back, and the two always agree.
 */
export function demoPeerKey(handleOrKey: string): string {
  const raw = handleOrKey.trim();
  if (/^0[23][0-9a-f]{64}$/i.test(raw)) return raw.toLowerCase();
  const tag = raw.replace(/^@/, "").toLowerCase();
  const hex = [...tag]
    .map((c) => c.charCodeAt(0).toString(16).padStart(2, "0"))
    .join("")
    .padEnd(64, "0")
    .slice(0, 64);
  return `02${hex}`;
}

function freshState(nametag?: string): DemoWalletState {
  return {
    chainPubkey: `02${randHex(32)}`,
    directAddress: `DIRECT://${randHex(20)}`,
    nametag: nametag ?? `demo${Math.floor(Math.random() * 9000 + 1000)}`,
    balance: "250000000000000000000", // 250 UCT
    locked: false,
    history: [],
    messages: [],
  };
}

export function loadDemoState(): DemoWalletState {
  try {
    const raw = localStorage.getItem(DEMO_KEY);
    if (raw) return { ...freshState(), ...(JSON.parse(raw) as DemoWalletState) };
  } catch {
    /* fall through to a fresh wallet */
  }
  const s = freshState();
  saveDemoState(s);
  return s;
}

export function saveDemoState(s: DemoWalletState): void {
  try {
    localStorage.setItem(DEMO_KEY, JSON.stringify(s));
  } catch {
    /* private mode — the demo simply will not persist */
  }
}

export function resetDemoWallet(): void {
  localStorage.removeItem(DEMO_KEY);
}

/* ------------------------------------------------- approval bridge (UI) */

export interface DemoApprovalRequest {
  id: string;
  action: string;
  params: Record<string, unknown>;
  resolve: (approved: boolean) => void;
}

type ApprovalListener = (req: DemoApprovalRequest | null) => void;

let approvalListener: ApprovalListener | null = null;
const approvalQueue: DemoApprovalRequest[] = [];

/** The demo approval sheet subscribes here; it plays the wallet's UI. */
export function onDemoApproval(fn: ApprovalListener | null): () => void {
  approvalListener = fn;
  if (fn && approvalQueue.length) fn(approvalQueue[0]);
  return () => {
    if (approvalListener === fn) approvalListener = null;
  };
}

function askUser(action: string, params: Record<string, unknown>): Promise<boolean> {
  return new Promise((resolve) => {
    const req: DemoApprovalRequest = {
      id: randHex(6),
      action,
      params,
      resolve: (approved) => {
        const idx = approvalQueue.findIndex((r) => r.id === req.id);
        if (idx >= 0) approvalQueue.splice(idx, 1);
        approvalListener?.(approvalQueue[0] ?? null);
        resolve(approved);
      },
    };
    approvalQueue.push(req);
    if (approvalQueue.length === 1) approvalListener?.(req);
  });
}

/* ----------------------------------------------------------- the host */

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * An in-memory ConnectTransport whose far side is the simulated wallet.
 * Plugged straight into the real `ConnectClient`.
 */
export class DemoTransport implements ConnectTransport {
  private handlers = new Set<(m: SphereConnectMessage) => void>();
  private state: DemoWalletState;
  private sessionId: string | null = null;
  private subscriptions = new Set<string>();
  private destroyed = false;

  constructor() {
    this.state = loadDemoState();
  }

  /* -- transport surface ------------------------------------------------ */

  send(message: SphereConnectMessage): void {
    if (this.destroyed) return;
    // The wire is async in reality; keep it async here so races surface in demo too.
    void this.handle(message);
  }

  onMessage(handler: (message: SphereConnectMessage) => void): () => void {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  destroy(): void {
    this.destroyed = true;
    this.handlers.clear();
    this.subscriptions.clear();
  }

  /* -- helpers used by the dApp's demo controls ------------------------- */

  getState(): DemoWalletState {
    return this.state;
  }

  setLocked(locked: boolean): void {
    this.state.locked = locked;
    saveDemoState(this.state);
    this.emitEvent(locked ? WALLET_EVENTS.LOCKED : WALLET_EVENTS.UNLOCKED, locked ? {} : { identity: this.identity() });
  }

  /** Simulate money arriving from the outside world. */
  credit(amount: string, from: string, memo?: string): void {
    this.state.balance = (BigInt(this.state.balance) + BigInt(amount)).toString();
    this.state.history.unshift({
      id: randHex(8),
      direction: "in",
      counterparty: from,
      amount,
      coinId: COIN.id,
      memo,
      at: Date.now(),
    });
    saveDemoState(this.state);
    this.emitEvent("transfer:incoming", { from, amount, coinId: COIN.id, memo });
  }

  /* -- internals -------------------------------------------------------- */

  private identity() {
    return {
      chainPubkey: this.state.chainPubkey,
      directAddress: this.state.directAddress,
      nametag: `@${this.state.nametag}`,
    };
  }

  private post(message: SphereConnectMessage): void {
    if (this.destroyed) return;
    for (const h of this.handlers) h(message);
  }

  private emitEvent(event: string, data: unknown): void {
    this.post({
      ns: SPHERE_CONNECT_NAMESPACE,
      v: SPHERE_CONNECT_VERSION,
      type: "event",
      event,
      data,
    } as SphereConnectMessage);
  }

  private respond(id: string, result: unknown): void {
    this.post({
      ns: SPHERE_CONNECT_NAMESPACE,
      v: SPHERE_CONNECT_VERSION,
      type: "response",
      id,
      result,
    } as SphereConnectMessage);
  }

  private respondError(id: string, code: number, message: string, data?: unknown): void {
    this.post({
      ns: SPHERE_CONNECT_NAMESPACE,
      v: SPHERE_CONNECT_VERSION,
      type: "response",
      id,
      error: { code, message, data },
    } as SphereConnectMessage);
  }

  private intentResult(id: string, result: unknown): void {
    this.post({
      ns: SPHERE_CONNECT_NAMESPACE,
      v: SPHERE_CONNECT_VERSION,
      type: "intent_result",
      id,
      result,
    } as SphereConnectMessage);
  }

  private intentError(id: string, code: number, message: string): void {
    this.post({
      ns: SPHERE_CONNECT_NAMESPACE,
      v: SPHERE_CONNECT_VERSION,
      type: "intent_result",
      id,
      error: { code, message },
    } as SphereConnectMessage);
  }

  private async handle(message: SphereConnectMessage): Promise<void> {
    await wait(60);

    if (message.type === "handshake" && message.direction === "request") {
      this.sessionId = message.sessionId ?? `demo-${randHex(8)}`;
      this.post({
        ns: SPHERE_CONNECT_NAMESPACE,
        v: SPHERE_CONNECT_VERSION,
        type: "handshake",
        direction: "response",
        sessionId: this.sessionId,
        permissions: message.permissions,
        identity: this.identity(),
        network: NETWORK,
        locked: this.state.locked || undefined,
      } as SphereConnectMessage);
      return;
    }

    if (message.type === "request") {
      // A locked wallet serves exactly four methods; everything else is 4009.
      const lockAllowed: string[] = [
        RPC_METHODS.GET_IDENTITY,
        RPC_METHODS.SUBSCRIBE,
        RPC_METHODS.UNSUBSCRIBE,
        RPC_METHODS.DISCONNECT,
      ];
      if (this.state.locked && !lockAllowed.includes(message.method)) {
        this.respondError(message.id, ERROR_CODES.WALLET_LOCKED, "Wallet is locked", {
          reason: "locked",
          unlockSurface: "background",
        });
        return;
      }
      this.handleQuery(message.id, message.method, message.params ?? {});
      return;
    }

    if (message.type === "intent") {
      if (this.state.locked) {
        this.intentError(message.id, ERROR_CODES.WALLET_LOCKED, "Wallet is locked");
        return;
      }
      await this.handleIntent(message.id, message.action, message.params ?? {});
    }
  }

  private handleQuery(id: string, method: string, params: Record<string, unknown>): void {
    const s = this.state;

    switch (method) {
      case RPC_METHODS.GET_IDENTITY:
        return this.respond(id, this.identity());

      case RPC_METHODS.GET_BALANCE:
        return this.respond(id, [{ coinId: COIN.id, amount: s.balance, symbol: COIN.symbol, decimals: COIN.decimals }]);

      case RPC_METHODS.GET_ASSETS:
        return this.respond(id, [
          {
            coinId: COIN.id,
            symbol: COIN.symbol,
            name: "Unicity",
            decimals: COIN.decimals,
            amount: s.balance,
            fiatValue: null,
          },
        ]);

      case RPC_METHODS.GET_FIAT_BALANCE:
        return this.respond(id, { fiatBalance: null });

      case RPC_METHODS.GET_TOKENS:
        return this.respond(id, [{ tokenId: randHex(32), coinId: COIN.id, amount: s.balance }]);

      case RPC_METHODS.GET_HISTORY:
        return this.respond(id, s.history);

      case RPC_METHODS.RESOLVE: {
        const identifier = String(params.identifier ?? "");
        const tag = identifier.replace(/^@/, "");
        if (!tag) return this.respondError(id, ERROR_CODES.INVALID_PARAMS, "Missing identifier");
        return this.respond(id, {
          identifier,
          nametag: `@${tag}`,
          chainPubkey: demoPeerKey(tag),
          directAddress: `DIRECT://demo-${tag}`,
        });
      }

      case RPC_METHODS.GET_CONVERSATIONS: {
        const byPeer = new Map<string, { peer: string; last: number; unread: number }>();
        for (const m of s.messages) {
          const e = byPeer.get(m.peer) ?? { peer: m.peer, last: 0, unread: 0 };
          e.last = Math.max(e.last, m.at);
          if (!m.fromMe && !m.read) e.unread += 1;
          byPeer.set(m.peer, e);
        }
        return this.respond(id, [...byPeer.values()].sort((a, b) => b.last - a.last));
      }

      case RPC_METHODS.GET_MESSAGES: {
        const peer = String(params.peerPubkey ?? "");
        return this.respond(
          id,
          s.messages.filter((m) => m.peer === peer).sort((a, b) => a.at - b.at),
        );
      }

      case RPC_METHODS.GET_DM_UNREAD_COUNT: {
        const peer = params.peerPubkey ? String(params.peerPubkey) : null;
        const count = s.messages.filter((m) => !m.fromMe && !m.read && (!peer || m.peer === peer)).length;
        return this.respond(id, { count });
      }

      case RPC_METHODS.MARK_AS_READ: {
        const ids = new Set((params.messageIds as string[]) ?? []);
        for (const m of s.messages) if (ids.has(m.id)) m.read = true;
        saveDemoState(s);
        return this.respond(id, { acknowledged: ids.size });
      }

      case RPC_METHODS.SUBSCRIBE:
        this.subscriptions.add(String(params.event ?? ""));
        return this.respond(id, { subscribed: true, event: params.event });

      case RPC_METHODS.UNSUBSCRIBE:
        this.subscriptions.delete(String(params.event ?? ""));
        return this.respond(id, { unsubscribed: true, event: params.event });

      case RPC_METHODS.DISCONNECT:
        this.sessionId = null;
        this.respond(id, { disconnected: true });
        this.emitEvent(WALLET_EVENTS.DISCONNECTED, {});
        return;

      default:
        return this.respondError(id, ERROR_CODES.METHOD_NOT_FOUND, `Unknown method: ${method}`);
    }
  }

  private async handleIntent(id: string, action: string, params: Record<string, unknown>): Promise<void> {
    const approved = await askUser(action, params);
    if (!approved) {
      this.intentError(id, ERROR_CODES.USER_REJECTED, "User rejected the request");
      return;
    }

    const s = this.state;
    await wait(420); // the wallet is doing work

    switch (action) {
      case INTENT_ACTIONS.SEND: {
        const amount = String(params.amount ?? "0");
        if (BigInt(s.balance) < BigInt(amount)) {
          this.intentError(id, ERROR_CODES.INSUFFICIENT_BALANCE, "Insufficient balance");
          return;
        }
        s.balance = (BigInt(s.balance) - BigInt(amount)).toString();
        const transferId = randHex(16);
        s.history.unshift({
          id: transferId,
          direction: "out",
          counterparty: String(params.to ?? ""),
          amount,
          coinId: String(params.coinId ?? COIN.id),
          memo: params.memo ? String(params.memo) : undefined,
          at: Date.now(),
        });
        saveDemoState(s);
        this.intentResult(id, {
          success: true,
          transferId,
          status: "confirmed",
          deliveryPending: false,
        });
        return;
      }

      case INTENT_ACTIONS.DM: {
        const peer = demoPeerKey(String(params.to ?? ""));
        const messageId = randHex(12);
        s.messages.push({
          id: messageId,
          peer,
          fromMe: true,
          body: String(params.message ?? ""),
          at: Date.now(),
          read: true,
        });
        saveDemoState(s);
        this.intentResult(id, { sent: true, messageId, timestamp: Date.now() });
        return;
      }

      case INTENT_ACTIONS.SIGN_MESSAGE: {
        // A DEMO signature. Deterministic, shaped like the real thing
        // (130 hex chars), and explicitly not verifiable as secp256k1 —
        // the server accepts it only when DEMO_MODE is on.
        const msg = String(params.message ?? "");
        const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(msg + s.chainPubkey));
        const hex = Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
        this.intentResult(id, {
          signature: `de${hex}${hex}`.slice(0, 130),
          publicKey: s.chainPubkey,
        });
        return;
      }

      case INTENT_ACTIONS.MINT: {
        const amount = String(params.amount ?? "0");
        s.balance = (BigInt(s.balance) + BigInt(amount)).toString();
        saveDemoState(s);
        this.intentResult(id, { tokenId: randHex(32), coinId: params.coinId, amount });
        return;
      }

      case INTENT_ACTIONS.RECEIVE:
        this.intentResult(id, { transfers: [] });
        return;

      case INTENT_ACTIONS.PAYMENT_REQUEST:
        this.intentResult(id, { success: true, requestId: randHex(10) });
        return;

      default:
        this.intentError(id, ERROR_CODES.METHOD_NOT_FOUND, `Unknown intent: ${action}`);
    }
  }
}

/** Singleton so demo controls in the UI can drive the same wallet the client talks to. */
let active: DemoTransport | null = null;

export function getDemoTransport(): DemoTransport {
  if (!active) active = new DemoTransport();
  return active;
}

export function dropDemoTransport(): void {
  active?.destroy();
  active = null;
}
