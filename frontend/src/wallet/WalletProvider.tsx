/* ==========================================================================
 * WALLET ADAPTER — Sphere Connect
 *
 * One hook owns the entire wallet lifecycle:
 *   P1 iframe  → P2 extension → P3 popup      (transport priority)
 *   silent auto-connect on mount               (no popup flash)
 *   lock / unlock as a SESSION-PRESERVING state, not a disconnect
 *   typed error classification for every request
 *
 * Rules encoded here, from the Connect 2.1 protocol reference:
 *  · `wallet:locked` keeps the session alive on a 2.1 wallet — do NOT tear down.
 *    A 2.0 wallet means the opposite, so we feature-detect on walletProtocol.
 *  · While locked, stop issuing reads. Every refusal bumps the wallet's blocked
 *    request badge. Resume on `unlockEpoch`.
 *  · NEVER auto-replay an intent after unlock — it moves money with no gesture.
 *  · 4201 INTENT_OUTCOME_UNKNOWN is never retried, only reconciled.
 * ======================================================================== */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  ConnectClient,
  RPC_METHODS,
  WALLET_EVENTS,
  type ConnectResult,
  type PermissionScope,
  type PublicIdentity,
} from "@unicitylabs/sphere-sdk/connect";
import { autoConnect, hasExtension, isInIframe } from "@unicitylabs/sphere-sdk/connect/browser";
import { DAPP, NETWORK, REQUIRED_SCOPES, STORAGE, SUBSCRIBED_EVENTS, WALLET_URL } from "../lib/config";
import { classifyRequestError, describeConnectFailure } from "../lib/connectErrors";
import { dropDemoTransport, getDemoTransport } from "./demoHost";
import { popupPathIsBlocked } from "./environment";

export type TransportKind = "iframe" | "extension" | "popup" | "demo" | null;

/**
 * `@unicitylabs/sphere-sdk/connect` and `.../connect/browser` each ship their own
 * declaration of ConnectClient, and TypeScript treats them as distinct nominal
 * types because of a private field. They are the same class at runtime, so we
 * hold the client through the surface we actually use.
 */
interface WalletClient {
  query<T = unknown>(method: string, params?: Record<string, unknown>): Promise<T>;
  intent<T = unknown>(action: string, params: Record<string, unknown>): Promise<T>;
  on(event: string, handler: (data: unknown) => void): () => void;
  readonly walletProtocol: string | null;
  readonly walletIdentity: PublicIdentity | null;
}

export interface WalletApi {
  /* connection */
  isConnected: boolean;
  isConnecting: boolean;
  isAutoConnecting: boolean;
  transport: TransportKind;
  error: string | null;

  /* identity */
  identity: PublicIdentity | null;
  permissions: readonly PermissionScope[];
  walletProtocol: string | null;

  /* lock */
  isWalletLocked: boolean;
  unlockEpoch: number;
  walletChanged: boolean;

  /* demo */
  isDemo: boolean;

  /* actions */
  connect: () => Promise<void>;
  connectDemo: () => Promise<void>;
  disconnect: () => Promise<void>;
  query: <T = unknown>(method: string, params?: Record<string, unknown>) => Promise<T>;
  intent: <T = unknown>(action: string, params: Record<string, unknown>) => Promise<T>;
  on: (event: string, handler: (data: unknown) => void) => () => void;
  clearError: () => void;
  raiseWallet: () => void;
}

const WalletContext = createContext<WalletApi | null>(null);

export function useWallet(): WalletApi {
  const ctx = useContext(WalletContext);
  if (!ctx) throw new Error("useWallet must be used inside <WalletProvider>");
  return ctx;
}

/** Parse the wallet's Connect MINOR. Unknown / unparseable is treated as legacy. */
function supportsGracefulLock(protocol: string | null): boolean {
  const minor = Number(/^\d+\.(\d+)$/.exec(protocol ?? "")?.[1] ?? NaN);
  return Number.isFinite(minor) && minor >= 1;
}

export function WalletProvider({ children }: { children: ReactNode }) {
  const clientRef = useRef<WalletClient | null>(null);
  const disposeRef = useRef<(() => Promise<void>) | null>(null);
  const popupRef = useRef<Window | null>(null);

  const [isConnected, setConnected] = useState(false);
  const [isConnecting, setConnecting] = useState(false);
  const [transport, setTransport] = useState<TransportKind>(null);
  const [identity, setIdentity] = useState<PublicIdentity | null>(null);
  const [permissions, setPermissions] = useState<readonly PermissionScope[]>([]);
  const [walletProtocol, setWalletProtocol] = useState<string | null>(null);
  const [isWalletLocked, setLocked] = useState(false);
  const [unlockEpoch, setUnlockEpoch] = useState(0);
  const [walletChanged, setWalletChanged] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isDemo, setDemo] = useState(false);

  /* A silent check runs on mount whenever any persistent path could restore a
   * session. Starting `isAutoConnecting` as true is what stops the Connect
   * button from flashing before the check resolves. */
  const [isAutoConnecting, setAutoConnecting] = useState(() => {
    if (typeof window === "undefined") return false;
    if (sessionStorage.getItem(STORAGE.demo) === "1") return true;
    return isInIframe() || hasExtension() || !!sessionStorage.getItem(STORAGE.popupSession);
  });

  /* ------------------------------------------------------------- teardown */

  const teardown = useCallback(() => {
    clientRef.current = null;
    popupRef.current = null;
    setConnected(false);
    setIdentity(null);
    setPermissions([]);
    setWalletProtocol(null);
    setLocked(false);
    setWalletChanged(false);
    setTransport(null);
    setDemo(false);
    sessionStorage.removeItem(STORAGE.popupSession);
    sessionStorage.removeItem(STORAGE.demo);
  }, []);

  /* -------------------------------------------- lifecycle event wiring */

  const wireLifecycle = useCallback(
    (client: WalletClient) => {
      const connectedPubkey = client.walletIdentity?.chainPubkey ?? null;

      // LOCKED. On 2.1 the session survives. On 2.0 it is already gone.
      client.on(WALLET_EVENTS.LOCKED, () => {
        if (!supportsGracefulLock(client.walletProtocol)) {
          teardown();
          return;
        }
        setLocked(true);
      });

      // UNLOCKED. Same session; the host has already re-armed subscriptions.
      client.on(WALLET_EVENTS.UNLOCKED, (data) => {
        const next = (data as { identity?: PublicIdentity } | undefined)?.identity ?? null;
        setLocked(false);
        if (next?.chainPubkey && connectedPubkey && next.chainPubkey !== connectedPubkey) {
          // A different seed came back from behind the lock screen.
          setWalletChanged(true);
          setIdentity(next);
        } else {
          if (next) setIdentity(next);
          setUnlockEpoch((n) => n + 1); // read panels re-fetch on this
        }
      });

      client.on(WALLET_EVENTS.DISCONNECTED, () => teardown());

      client.on(WALLET_EVENTS.IDENTITY_CHANGED, (data) => {
        const next = data as PublicIdentity | undefined;
        if (next?.chainPubkey) {
          setIdentity(next);
          if (connectedPubkey && next.chainPubkey !== connectedPubkey) setWalletChanged(true);
        }
      });

      // Subscribable events must be armed explicitly. Auto-pushed ones must not.
      for (const ev of SUBSCRIBED_EVENTS) {
        client.query(RPC_METHODS.SUBSCRIBE, { event: ev }).catch(() => {
          /* a wallet that does not serve this event is not an error worth surfacing */
        });
      }
    },
    [teardown],
  );

  const adopt = useCallback(
    (client: WalletClient, result: ConnectResult, kind: TransportKind) => {
      clientRef.current = client;
      setConnected(true);
      setIdentity(result.identity);
      setPermissions(result.permissions);
      setWalletProtocol(client.walletProtocol);
      setLocked(result.locked === true);
      setTransport(kind);
      setError(null);
      wireLifecycle(client);
    },
    [wireLifecycle],
  );

  /* ------------------------------------------------------- real connect */

  const runConnect = useCallback(
    async (silent: boolean) => {
      const resume = sessionStorage.getItem(STORAGE.popupSession) ?? undefined;

      const res = await autoConnect({
        dapp: DAPP,
        walletUrl: WALLET_URL,
        permissions: REQUIRED_SCOPES,
        network: NETWORK,
        silent,
        resumeSessionId: resume,
      });

      const kind = res.transport as TransportKind;
      disposeRef.current = res.disconnect;

      // Popup sessions are the only ones that need manual resume bookkeeping;
      // the extension's service worker keeps its own session alive.
      if (kind === "popup") {
        sessionStorage.setItem(STORAGE.popupSession, res.connection.sessionId);
      } else {
        sessionStorage.removeItem(STORAGE.popupSession);
      }

      adopt(res.client, res.connection, kind);
    },
    [adopt],
  );

  const connect = useCallback(async () => {
    setConnecting(true);
    setError(null);
    try {
      await runConnect(false);
    } catch (err) {
      sessionStorage.removeItem(STORAGE.popupSession);
      // A popup against the hosted wallet never reaches a wallet at all — the
      // CDN answers 403 — so the SDK's timeout is a true but useless message.
      setError(
        popupPathIsBlocked()
          ? "The hosted Sphere wallet does not serve the popup path (403 at the CDN). Install the Sphere extension, or run this dApp inside Sphere as a custom agent — see the options below."
          : describeConnectFailure(err),
      );
    } finally {
      setConnecting(false);
    }
  }, [runConnect]);

  /* ------------------------------------------------------- demo connect */

  const connectDemo = useCallback(async () => {
    setConnecting(true);
    setError(null);
    try {
      const t = getDemoTransport();
      const client = new ConnectClient({
        transport: t,
        dapp: DAPP,
        permissions: REQUIRED_SCOPES,
        network: NETWORK,
      });
      const result = await client.connect();
      disposeRef.current = async () => {
        await client.disconnect().catch(() => {});
        dropDemoTransport();
      };
      sessionStorage.setItem(STORAGE.demo, "1");
      setDemo(true);
      adopt(client, result, "demo");
    } catch (err) {
      setError(describeConnectFailure(err));
    } finally {
      setConnecting(false);
    }
  }, [adopt]);

  /* ---------------------------------------------- silent check on mount */

  useEffect(() => {
    let cancelled = false;

    (async () => {
      if (!isAutoConnecting) return;
      try {
        if (sessionStorage.getItem(STORAGE.demo) === "1") {
          await connectDemo();
        } else {
          await runConnect(true);
        }
      } catch {
        // Not approved yet, or the wallet cold-started locked. Either way we
        // simply park and show the Connect button — a rejection we did not
        // expect is "not ready", never a hard failure.
        sessionStorage.removeItem(STORAGE.popupSession);
      } finally {
        if (!cancelled) setAutoConnecting(false);
      }
    })();

    return () => {
      cancelled = true;
    };
    // Intentionally mount-only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /* ------------------------------------------------------------ actions */

  const disconnect = useCallback(async () => {
    try {
      await disposeRef.current?.();
    } catch {
      /* the session may already be gone */
    }
    disposeRef.current = null;
    teardown();
  }, [teardown]);

  const raiseWallet = useCallback(() => {
    if (transport === "popup" && popupRef.current && !popupRef.current.closed) {
      popupRef.current.focus();
      return;
    }
    if (transport === "iframe") {
      // The wallet owns the surrounding chrome; nothing for us to raise.
      return;
    }
    window.open(WALLET_URL, "_blank", "noopener");
  }, [transport]);

  const query = useCallback(
    async <T,>(method: string, params?: Record<string, unknown>): Promise<T> => {
      const client = clientRef.current;
      if (!client) throw new Error("Not connected");
      try {
        return await client.query<T>(method, params);
      } catch (err) {
        const kind = classifyRequestError(err);
        if (kind === "locked") setLocked(true);
        if (kind === "teardown") teardown();
        throw err;
      }
    },
    [teardown],
  );

  const intent = useCallback(
    async <T,>(action: string, params: Record<string, unknown>): Promise<T> => {
      const client = clientRef.current;
      if (!client) throw new Error("Not connected");

      // Sample the browser's transient-activation flag SYNCHRONOUSLY, before any
      // await: it separates "the user pressed the button" from "a poller ran",
      // so a background request never steals focus.
      const userDriven = navigator.userActivation?.isActive ?? true;

      try {
        return await client.intent<T>(action, params);
      } catch (err) {
        const kind = classifyRequestError(err);
        if (kind === "locked") {
          setLocked(true);
          if (userDriven) raiseWallet();
        }
        if (kind === "teardown") teardown();
        throw err;
      }
    },
    [raiseWallet, teardown],
  );

  const on = useCallback((event: string, handler: (data: unknown) => void) => {
    const client = clientRef.current;
    if (!client) return () => {};
    return client.on(event, handler);
  }, []);

  const value = useMemo<WalletApi>(
    () => ({
      isConnected,
      isConnecting,
      isAutoConnecting,
      transport,
      error,
      identity,
      permissions,
      walletProtocol,
      isWalletLocked,
      unlockEpoch,
      walletChanged,
      isDemo,
      connect,
      connectDemo,
      disconnect,
      query,
      intent,
      on,
      clearError: () => setError(null),
      raiseWallet,
    }),
    [
      isConnected,
      isConnecting,
      isAutoConnecting,
      transport,
      error,
      identity,
      permissions,
      walletProtocol,
      isWalletLocked,
      unlockEpoch,
      walletChanged,
      isDemo,
      connect,
      connectDemo,
      disconnect,
      query,
      intent,
      on,
      raiseWallet,
    ],
  );

  return <WalletContext.Provider value={value}>{children}</WalletContext.Provider>;
}
