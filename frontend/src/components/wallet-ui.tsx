import { useEffect, useState } from "react";
import { INTENT_ACTIONS } from "@unicitylabs/sphere-sdk/connect";
import { useWallet } from "../wallet/WalletProvider";
import { useSession } from "../app/SessionProvider";
import { getDemoTransport, onDemoApproval, resetDemoWallet, type DemoApprovalRequest } from "../wallet/demoHost";
import { COIN } from "../lib/config";
import { displayName, formatCoin, shortKey } from "../lib/format";
import { Button, Label, useToast } from "./ui";

/* ==========================================================================
 * Connect / identity
 * ========================================================================== */

export function ConnectPanel({ compact = false }: { compact?: boolean }) {
  const wallet = useWallet();
  const session = useSession();

  if (wallet.isAutoConnecting) {
    return (
      <div className="connect connect--checking">
        <span className="btn__spin" aria-hidden />
        <Label>restoring session</Label>
      </div>
    );
  }

  if (!wallet.isConnected) {
    return (
      <div className={`connect ${compact ? "connect--compact" : ""}`}>
        <Button variant="primary" onClick={wallet.connect} loading={wallet.isConnecting}>
          Connect Sphere
        </Button>
        <Button variant="ghost" size="sm" onClick={wallet.connectDemo} disabled={wallet.isConnecting}>
          Try demo wallet
        </Button>
        {wallet.error && <p className="connect__error">{wallet.error}</p>}
      </div>
    );
  }

  // `needsSignIn` goes false the moment signing starts, so the in-flight state
  // has to be part of this branch or the identity chip flashes mid-signature.
  if (session.needsSignIn || session.isSigningIn) {
    return (
      <div className={`connect ${compact ? "connect--compact" : ""}`}>
        <Button variant="primary" onClick={session.signIn} loading={session.isSigningIn}>
          Sign in with Sphere
        </Button>
        {session.signInError && <p className="connect__error">{session.signInError}</p>}
      </div>
    );
  }

  return <IdentityChip />;
}

export function IdentityChip() {
  const wallet = useWallet();
  const session = useSession();
  const [open, setOpen] = useState(false);

  const name = displayName(wallet.identity);

  return (
    <div className="idchip">
      <button className="idchip__btn" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
        <span className={`dot ${wallet.isWalletLocked ? "" : "dot--pulse"}`} style={{ color: wallet.isWalletLocked ? "var(--warn)" : "var(--ok)" }} />
        <span className="idchip__name mono">{name}</span>
        <span className="idchip__caret" aria-hidden>
          {open ? "▲" : "▼"}
        </span>
      </button>

      {open && (
        <>
          <div className="idchip__scrim" onClick={() => setOpen(false)} />
          <div className="idchip__menu">
            <div className="idchip__row">
              <Label>transport</Label>
              <span className="mono">{wallet.transport ?? "—"}</span>
            </div>
            <div className="idchip__row">
              <Label>protocol</Label>
              <span className="mono">{wallet.walletProtocol ?? "—"}</span>
            </div>
            <div className="idchip__row">
              <Label>key</Label>
              <span className="mono">{shortKey(wallet.identity?.chainPubkey, 8, 6)}</span>
            </div>
            <div className="idchip__row idchip__row--wrap">
              <Label>scopes granted</Label>
              <div className="idchip__scopes">
                {wallet.permissions.map((p) => (
                  <span key={p} className="chip">
                    {p}
                  </span>
                ))}
              </div>
            </div>
            <Button
              variant="ghost"
              size="sm"
              block
              onClick={() => {
                setOpen(false);
                void session.signOut();
              }}
            >
              Disconnect
            </Button>
          </div>
        </>
      )}
    </div>
  );
}

/* ==========================================================================
 * Lock banner
 *
 * A locked wallet on Connect 2.1 keeps the session. We say so plainly instead
 * of pretending the app broke, and we stop issuing reads until the unlock.
 * ========================================================================== */

export function LockBanner() {
  const wallet = useWallet();
  if (!wallet.isConnected) return null;

  if (wallet.walletChanged) {
    return (
      <div className="banner banner--danger">
        <Label tone="accent">wallet changed</Label>
        <p>
          A different wallet came back from the lock screen. Your session belongs to the previous key.
        </p>
        <Button size="sm" variant="ghost" onClick={() => void wallet.disconnect()}>
          Reconnect
        </Button>
      </div>
    );
  }

  if (!wallet.isWalletLocked) return null;

  return (
    <div className="banner banner--warn">
      <Label tone="accent">wallet locked</Label>
      <p>
        Your session is still alive — Sphere is just locked. Unlock it in the wallet and this page picks up
        where it left off.
      </p>
      <Button size="sm" variant="ghost" onClick={wallet.raiseWallet}>
        Open wallet
      </Button>
    </div>
  );
}

/* ==========================================================================
 * Demo banner + controls
 * ========================================================================== */

export function DemoBanner() {
  const wallet = useWallet();
  const toast = useToast();
  const [balance, setBalance] = useState<string | null>(null);

  useEffect(() => {
    if (!wallet.isDemo) return;
    const read = () => setBalance(getDemoTransport().getState().balance);
    read();
    const id = setInterval(read, 1500);
    return () => clearInterval(id);
  }, [wallet.isDemo]);

  if (!wallet.isDemo) return null;

  return (
    <div className="banner banner--demo">
      <Label tone="accent">demo wallet</Label>
      <p>
        Simulated Sphere wallet over the real Connect protocol. Nothing here touches a chain and no funds
        move. Balance <span className="num">{balance ? formatCoin(balance) : "—"}</span>.
      </p>
      <div className="row" style={{ gap: "0.5rem" }}>
        <Button
          size="sm"
          variant="ghost"
          onClick={() => {
            const t = getDemoTransport();
            t.setLocked(true);
            toast.push({ tone: "warn", title: "Demo wallet locked", body: "The session stays alive — that is the point." });
          }}
        >
          Lock
        </Button>
        <Button
          size="sm"
          variant="ghost"
          onClick={() => {
            getDemoTransport().setLocked(false);
            toast.push({ tone: "ok", title: "Demo wallet unlocked" });
          }}
        >
          Unlock
        </Button>
        <Button
          size="sm"
          variant="ghost"
          onClick={async () => {
            try {
              await wallet.intent(INTENT_ACTIONS.MINT, { coinId: COIN.id, amount: "100000000000000000000" });
              toast.push({ tone: "ok", title: "Minted 100 UCT", body: "Self-mint is testnet2's replacement for a faucet." });
            } catch {
              toast.push({ tone: "warn", title: "Mint declined" });
            }
          }}
        >
          Mint 100
        </Button>
        <Button
          size="sm"
          variant="danger"
          onClick={() => {
            resetDemoWallet();
            void wallet.disconnect();
          }}
        >
          Reset
        </Button>
      </div>
    </div>
  );
}

/* --------------------------------------------------------------------------
 * The demo wallet's approval sheet. Plays the part the real Sphere wallet
 * plays: shows exactly what is being asked and waits for a human.
 * ------------------------------------------------------------------------ */

const INTENT_COPY: Record<string, { title: string; note: string }> = {
  [INTENT_ACTIONS.SEND]: { title: "Approve transfer", note: "Funds leave your wallet." },
  [INTENT_ACTIONS.DM]: { title: "Send message", note: "Encrypted end to end. The dApp never sees the body." },
  [INTENT_ACTIONS.SIGN_MESSAGE]: { title: "Sign message", note: "Proves you hold the key. Moves nothing." },
  [INTENT_ACTIONS.MINT]: { title: "Self-mint", note: "Creates tokens in your own wallet on testnet2." },
  [INTENT_ACTIONS.PAYMENT_REQUEST]: { title: "Payment request", note: "Asks someone else to pay." },
  [INTENT_ACTIONS.RECEIVE]: { title: "Receive", note: "Shows your receive address." },
};

export function DemoApprovalSheet() {
  const [req, setReq] = useState<DemoApprovalRequest | null>(null);

  useEffect(() => onDemoApproval(setReq), []);

  if (!req) return null;

  const copy = INTENT_COPY[req.action] ?? { title: req.action, note: "" };
  const params = req.params as Record<string, unknown>;

  return (
    <div className="sheet" role="dialog" aria-modal="true" aria-label={copy.title}>
      <div className="sheet__scrim" />
      <div className="sheet__card">
        <div className="sheet__head">
          <Label tone="accent">sphere · demo wallet</Label>
          <span className="chip chip--warn">simulated</span>
        </div>

        <h3 className="h3">{copy.title}</h3>
        <p className="muted sheet__note">{copy.note}</p>

        <div className="sheet__params">
          {req.action === INTENT_ACTIONS.SEND && (
            <>
              <ParamRow k="amount" v={formatCoin(String(params.amount ?? "0"))} highlight />
              <ParamRow k="to" v={String(params.to ?? "")} />
              <ParamRow k="memo" v={String(params.memo ?? "—")} />
              <ParamRow k="coin" v={`${COIN.symbol} · ${shortKey(String(params.coinId ?? ""), 8, 6)}`} />
            </>
          )}

          {req.action === INTENT_ACTIONS.DM && (
            <>
              <ParamRow k="to" v={String(params.to ?? "")} />
              <div className="sheet__msg">{String(params.message ?? "")}</div>
            </>
          )}

          {req.action === INTENT_ACTIONS.SIGN_MESSAGE && (
            <pre className="sheet__pre">{String(params.message ?? "")}</pre>
          )}

          {req.action === INTENT_ACTIONS.MINT && (
            <ParamRow k="amount" v={formatCoin(String(params.amount ?? "0"))} highlight />
          )}
        </div>

        <div className="sheet__actions">
          <Button variant="ghost" onClick={() => req.resolve(false)}>
            Reject
          </Button>
          <Button variant="primary" onClick={() => req.resolve(true)}>
            Approve
          </Button>
        </div>
      </div>
    </div>
  );
}

function ParamRow({ k, v, highlight = false }: { k: string; v: string; highlight?: boolean }) {
  return (
    <div className="sheet__row">
      <Label>{k}</Label>
      <span className={`mono sheet__val ${highlight ? "sheet__val--big" : ""}`}>{v}</span>
    </div>
  );
}
