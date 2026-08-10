/* ==========================================================================
 * SESSION — wallet identity turned into a backend session
 *
 * Connecting a wallet proves nothing to our server on its own: the handshake
 * happens between the dApp and the wallet, and the server never sees it. So we
 * do it properly — nonce, `sign_message`, pubkey recovery, token.
 *
 * The signature costs the user one approval, so we only ask when there is no
 * live token for the currently connected key.
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
import { INTENT_ACTIONS } from "@unicitylabs/sphere-sdk/connect";
import { api, loadToken, setToken, type AppConfig, type PublicUser } from "../lib/api";
import { describeConnectFailure } from "../lib/connectErrors";
import { useWallet } from "../wallet/WalletProvider";

interface SessionApi {
  config: AppConfig | null;
  me: PublicUser | null;
  isSigningIn: boolean;
  needsSignIn: boolean;
  signInError: string | null;
  signIn: () => Promise<void>;
  signOut: () => Promise<void>;
  refreshMe: () => Promise<void>;
}

const SessionContext = createContext<SessionApi | null>(null);

export function useSession(): SessionApi {
  const ctx = useContext(SessionContext);
  if (!ctx) throw new Error("useSession must be used inside <SessionProvider>");
  return ctx;
}

export function SessionProvider({ children }: { children: ReactNode }) {
  const wallet = useWallet();

  const [config, setConfig] = useState<AppConfig | null>(null);
  const [me, setMe] = useState<PublicUser | null>(null);
  const [isSigningIn, setSigningIn] = useState(false);
  const [signInError, setSignInError] = useState<string | null>(null);
  const attemptedFor = useRef<string | null>(null);

  useEffect(() => {
    api.config().then(setConfig).catch(() => setConfig(null));
  }, []);

  const refreshMe = useCallback(async () => {
    if (!loadToken()) {
      setMe(null);
      return;
    }
    try {
      const { user } = await api.me();
      setMe(user);
    } catch {
      setToken(null);
      setMe(null);
    }
  }, []);

  const signIn = useCallback(async () => {
    const pubkey = wallet.identity?.chainPubkey;
    if (!pubkey || wallet.isWalletLocked) return;

    setSigningIn(true);
    setSignInError(null);
    try {
      const { nonce, message } = await api.nonce(pubkey);

      const { signature } = await wallet.intent<{ signature: string; publicKey: string }>(
        INTENT_ACTIONS.SIGN_MESSAGE,
        { message },
      );

      const { token, user } = await api.verify({
        pubkey,
        nonce,
        signature,
        nametag: wallet.identity?.nametag ?? null,
      });

      setToken(token);
      setMe(user);
    } catch (err) {
      setSignInError(describeConnectFailure(err));
    } finally {
      setSigningIn(false);
    }
  }, [wallet]);

  const signOut = useCallback(async () => {
    setToken(null);
    setMe(null);
    attemptedFor.current = null;
    await wallet.disconnect();
  }, [wallet]);

  /* A token is bound to a pubkey. If the wallet behind the lock screen changed,
   * or the user switched accounts, the old token is not ours — drop it. */
  useEffect(() => {
    if (!wallet.isConnected) {
      setMe(null);
      attemptedFor.current = null;
      return;
    }
    const pubkey = wallet.identity?.chainPubkey ?? null;
    if (!pubkey) return;

    void (async () => {
      await refreshMe();
      setMe((current) => {
        if (current && current.pubkey !== pubkey) {
          setToken(null);
          return null;
        }
        return current;
      });
    })();
  }, [wallet.isConnected, wallet.identity?.chainPubkey, wallet.walletChanged, refreshMe]);

  const needsSignIn = wallet.isConnected && !wallet.isWalletLocked && !me && !isSigningIn;

  const value = useMemo<SessionApi>(
    () => ({ config, me, isSigningIn, needsSignIn, signInError, signIn, signOut, refreshMe }),
    [config, me, isSigningIn, needsSignIn, signInError, signIn, signOut, refreshMe],
  );

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}
