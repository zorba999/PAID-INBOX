import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { RPC_METHODS } from "@unicitylabs/sphere-sdk/connect";
import { api, ApiError } from "../lib/api";
import { COIN } from "../lib/config";
import { formatCoin, fromBaseUnits, safeToBaseUnits, shortKey } from "../lib/format";
import { useSession } from "../app/SessionProvider";
import { useWallet } from "../wallet/WalletProvider";
import { Button, Label, Stat, useToast } from "../components/ui";
import { Page } from "../components/Shell";

interface Asset {
  coinId?: string;
  amount?: string;
  symbol?: string;
}

export function Settings() {
  const session = useSession();
  const wallet = useWallet();
  const toast = useToast();

  const [handle, setHandle] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [bio, setBio] = useState("");
  const [price, setPrice] = useState("");
  const [windowHours, setWindowHours] = useState(72);
  const [isOpen, setIsOpen] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [balance, setBalance] = useState<string | null>(null);

  /* hydrate from the server profile */
  useEffect(() => {
    const me = session.me;
    if (!me) return;
    setHandle(me.handle ?? "");
    setDisplayName(me.displayName ?? "");
    setBio(me.bio ?? "");
    setPrice(fromBaseUnits(me.priceBase));
    setWindowHours(me.replyWindowHours);
    setIsOpen(me.isOpen);
  }, [session.me]);

  /* the wallet's own balance — a read, so it pauses while locked */
  useEffect(() => {
    if (!wallet.isConnected || wallet.isWalletLocked) return;
    let alive = true;
    void (async () => {
      try {
        const assets = await wallet.query<Asset[]>(RPC_METHODS.GET_ASSETS);
        const match = Array.isArray(assets)
          ? assets.find((a) => a.coinId?.toLowerCase() === COIN.id)
          : undefined;
        if (alive) setBalance(match?.amount ?? "0");
      } catch {
        if (alive) setBalance(null);
      }
    })();
    return () => {
      alive = false;
    };
  }, [wallet, wallet.isConnected, wallet.isWalletLocked, wallet.unlockEpoch]);

  const priceBase = safeToBaseUnits(price);
  const min = session.config?.minPriceBase ?? "0";
  const max = session.config?.maxPriceBase ?? "0";
  const priceOk =
    priceBase !== null && BigInt(priceBase) >= BigInt(min) && BigInt(priceBase) <= BigInt(max);

  const save = async () => {
    if (!priceBase) return;
    setSaving(true);
    setError(null);
    try {
      await api.updateMe({
        handle: handle.trim() || undefined,
        displayName: displayName.trim(),
        bio: bio.trim(),
        priceBase,
        replyWindowHours: windowHours,
        isOpen,
      });
      await session.refreshMe();
      toast.push({ tone: "ok", title: "Saved", body: "Your inbox page is live." });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not save");
    } finally {
      setSaving(false);
    }
  };

  const me = session.me;

  return (
    <Page
      eyebrow="settings"
      title="Your inbox"
      actions={
        me?.handle ? (
          <Link to={`/u/${me.handle}`} className="btn btn--ghost btn--sm">
            View public page
          </Link>
        ) : undefined
      }
    >
      <div className="figures figures--panel">
        <Stat label="wallet balance" value={balance === null ? "—" : formatCoin(balance, { maxFractionDigits: 3 })} />
        <Stat
          label="earned here"
          value={me ? formatCoin(me.stats.totalEarnedBase, { maxFractionDigits: 3 }) : "—"}
          accent
        />
        <Stat label="messages received" value={me ? String(me.stats.received) : "—"} />
        <Stat label="key" value={<span className="mono">{shortKey(me?.pubkey, 6, 4)}</span>} />
      </div>

      <div className="settings">
        <section className="settings__form">
          <label className="field">
            <div className="field__label">
              <Label tone="strong">handle</Label>
              <Label>this is your public link</Label>
            </div>
            <div className="handlefield">
              <span className="handlefield__at mono">@</span>
              <input
                className="input input--mono handlefield__input"
                value={handle}
                onChange={(e) => setHandle(e.target.value.replace(/^@/, ""))}
                placeholder="yourname"
                spellCheck={false}
                autoComplete="off"
              />
            </div>
            {wallet.identity?.nametag && (
              <p className="dim field__hint">
                Your wallet nametag is <span className="mono">{wallet.identity.nametag}</span>.
              </p>
            )}
          </label>

          <label className="field">
            <div className="field__label">
              <Label tone="strong">display name</Label>
            </div>
            <input
              className="input"
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              placeholder="How you want to be introduced"
              maxLength={60}
            />
          </label>

          <label className="field">
            <div className="field__label">
              <Label tone="strong">bio</Label>
              <span className="dim num">{bio.length}/280</span>
            </div>
            <textarea
              className="textarea"
              style={{ minHeight: "6rem" }}
              value={bio}
              onChange={(e) => setBio(e.target.value)}
              placeholder="What is worth paying you to ask about?"
              maxLength={280}
            />
          </label>

          <div className="settings__pair">
            <label className="field">
              <div className="field__label">
                <Label tone="strong">price</Label>
                <Label>{COIN.symbol}</Label>
              </div>
              <input
                className="input input--mono"
                value={price}
                onChange={(e) => setPrice(e.target.value)}
                inputMode="decimal"
                placeholder="1.0"
              />
              {!priceOk && price !== "" && (
                <p className="field__err">
                  Between {formatCoin(min, { maxFractionDigits: 2 })} and {formatCoin(max, { maxFractionDigits: 2 })}.
                </p>
              )}
            </label>

            <label className="field">
              <div className="field__label">
                <Label tone="strong">reply window</Label>
                <Label>hours</Label>
              </div>
              <select
                className="select"
                value={windowHours}
                onChange={(e) => setWindowHours(Number(e.target.value))}
              >
                {[6, 12, 24, 48, 72, 120, 168].map((h) => (
                  <option key={h} value={h}>
                    {h} hours{h === 72 ? " (default)" : ""}
                  </option>
                ))}
              </select>
            </label>
          </div>

          <label className="toggle">
            <input type="checkbox" checked={isOpen} onChange={(e) => setIsOpen(e.target.checked)} />
            <span className="toggle__track" aria-hidden>
              <span className="toggle__thumb" />
            </span>
            <span>
              <b>Inbox open</b>
              <span className="dim"> — turn this off and nobody can start a new thread.</span>
            </span>
          </label>

          {error && (
            <div className="notice notice--warn">
              <Label tone="accent">not saved</Label>
              <p>{error}</p>
            </div>
          )}

          <Button variant="primary" size="lg" onClick={save} loading={saving} disabled={!priceOk}>
            Save
          </Button>
        </section>

        <aside className="settings__aside">
          <div className="card card--pad">
            <Label tone="accent">how your price is read</Label>
            <p className="muted" style={{ marginTop: "0.8rem" }}>
              A price on its own means nothing — what makes it credible is the reply rate next to it. Set it
              high enough that answering is worth your time, and low enough that you actually answer.
            </p>
            <hr className="rule" />
            <div className="meta__row">
              <Label>platform fee</Label>
              <span className="mono">{session.config ? session.config.feeBps / 100 : "—"}%</span>
            </div>
            <div className="meta__row">
              <Label>you receive</Label>
              <span className="mono accent">
                {priceBase && session.config
                  ? formatCoin(((BigInt(priceBase) * BigInt(10_000 - session.config.feeBps)) / 10_000n).toString())
                  : "—"}
              </span>
            </div>
            <div className="meta__row">
              <Label>min reply length</Label>
              <span className="mono">{session.config?.minReplyChars ?? "—"} chars</span>
            </div>
            <div className="meta__row">
              <Label>dispute window</Label>
              <span className="mono">{session.config?.disputeWindowHours ?? "—"}h</span>
            </div>
          </div>

          <div className="card card--pad" style={{ marginTop: "1.25rem" }}>
            <Label tone="accent">connection</Label>
            <div className="meta__row">
              <Label>transport</Label>
              <span className="mono">{wallet.transport ?? "—"}</span>
            </div>
            <div className="meta__row">
              <Label>connect version</Label>
              <span className="mono">{wallet.walletProtocol ?? "—"}</span>
            </div>
            <div className="meta__row">
              <Label>network</Label>
              <span className="mono">{session.config?.network ?? "—"}</span>
            </div>
            <div className="meta__row">
              <Label>scopes</Label>
              <span className="mono">{wallet.permissions.length}</span>
            </div>
          </div>
        </aside>
      </div>
    </Page>
  );
}
