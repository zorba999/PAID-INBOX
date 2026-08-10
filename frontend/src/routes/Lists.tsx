import { useCallback, useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { api, type Thread } from "../lib/api";
import { formatCoin, relativeTime, shortKey } from "../lib/format";
import { useWallet } from "../wallet/WalletProvider";
import { useSession } from "../app/SessionProvider";
import { Countdown, Empty, Label, Spinner, Stat } from "../components/ui";
import { Page } from "../components/Shell";
import { StateChip } from "../components/StateChip";

/* ==========================================================================
 * Inbox — sorted by money, not by time. That is the whole product.
 * ========================================================================== */

export function Inbox() {
  const wallet = useWallet();
  const [threads, setThreads] = useState<Thread[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await api.inbox();
      setThreads(res.threads);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load the inbox");
      setThreads([]);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load, wallet.unlockEpoch]);

  // An incoming transfer usually means a new paid message landed.
  useEffect(() => {
    if (!wallet.isConnected) return;
    const off = wallet.on("transfer:incoming", () => void load());
    return off;
  }, [wallet, load]);

  const pending = useMemo(() => (threads ?? []).filter((t) => t.state === "DELIVERED"), [threads]);
  const earning = useMemo(() => (threads ?? []).filter((t) => t.state === "REPLIED"), [threads]);

  const openValue = useMemo(
    () => pending.reduce((a, t) => a + BigInt(t.netBase), 0n).toString(),
    [pending],
  );

  return (
    <Page
      eyebrow="inbox"
      title="Paid messages"
      actions={
        <Link to="/settings" className="btn btn--ghost btn--sm">
          Change my price
        </Link>
      }
    >
      <div className="figures figures--panel">
        <Stat label="waiting on you" value={String(pending.length)} accent={pending.length > 0} />
        <Stat label="claimable now" value={formatCoin(openValue, { maxFractionDigits: 2 })} />
        <Stat label="attested, releasing" value={String(earning.length)} />
      </div>

      {threads === null ? (
        <Spinner label="loading inbox" />
      ) : error ? (
        <p className="muted">{error}</p>
      ) : threads.length === 0 ? (
        <Empty
          title="Nothing here yet"
          body="Share your handle and set a price people are willing to pay. Your page works without a wallet, so anyone can open it."
          action={
            <Link to="/settings" className="btn btn--primary btn--sm">
              Set up my inbox
            </Link>
          }
        />
      ) : (
        <ul className="tlist">
          {threads.map((t) => (
            <ThreadRow key={t.id} t={t} side="in" />
          ))}
        </ul>
      )}
    </Page>
  );
}

/* ==========================================================================
 * Sent
 * ========================================================================== */

export function Sent() {
  const [threads, setThreads] = useState<Thread[] | null>(null);

  useEffect(() => {
    api
      .sent()
      .then((r) => setThreads(r.threads))
      .catch(() => setThreads([]));
  }, []);

  const spent = useMemo(
    () =>
      (threads ?? [])
        .filter((t) => !["PAYING", "REFUNDED", "EXPIRED"].includes(t.state))
        .reduce((a, t) => a + BigInt(t.priceBase), 0n)
        .toString(),
    [threads],
  );

  const refunded = useMemo(
    () =>
      (threads ?? [])
        .filter((t) => t.state === "REFUNDED")
        .reduce((a, t) => a + BigInt(t.priceBase), 0n)
        .toString(),
    [threads],
  );

  return (
    <Page eyebrow="sent" title="Messages you paid for">
      <div className="figures figures--panel">
        <Stat label="committed" value={formatCoin(spent, { maxFractionDigits: 2 })} />
        <Stat label="refunded" value={formatCoin(refunded, { maxFractionDigits: 2 })} />
        <Stat label="threads" value={String(threads?.length ?? 0)} />
      </div>

      {threads === null ? (
        <Spinner label="loading" />
      ) : threads.length === 0 ? (
        <Empty
          title="You have not reached out yet"
          body="Find an inbox worth paying for."
          action={
            <Link to="/explore" className="btn btn--primary btn--sm">
              Explore inboxes
            </Link>
          }
        />
      ) : (
        <ul className="tlist">
          {threads.map((t) => (
            <ThreadRow key={t.id} t={t} side="out" />
          ))}
        </ul>
      )}
    </Page>
  );
}

/* ------------------------------------------------------------------- row */

function ThreadRow({ t, side }: { t: Thread; side: "in" | "out" }) {
  const other = side === "in" ? t.sender : t.recipient;
  const urgent = t.state === "DELIVERED";

  return (
    <li className={`trow ${urgent ? "trow--urgent" : ""}`}>
      <Link to={`/t/${t.id}`} className="trow__link">
        <div className="trow__money">
          <span className="trow__amount num">{formatCoin(t.priceBase, { symbol: null, maxFractionDigits: 2 })}</span>
          <Label bare>UCT</Label>
        </div>

        <div className="trow__body">
          <div className="trow__top">
            <span className="mono trow__who">{other.handle ? `@${other.handle}` : shortKey(other.pubkey)}</span>
            <StateChip state={t.state} />
          </div>
          <p className="trow__subject">{t.subject}</p>
          <div className="trow__meta">
            <span className="dim num">{relativeTime(t.createdAt)}</span>
            {t.state === "DELIVERED" && t.deadlineAt && (
              <>
                <span className="dim">·</span>
                <Countdown to={t.deadlineAt} prefix="closes in " />
              </>
            )}
            {t.state === "REPLIED" && t.confirmUntil && (
              <>
                <span className="dim">·</span>
                <Countdown to={t.confirmUntil} prefix="releases in " />
              </>
            )}
          </div>
        </div>

        <span className="trow__go" aria-hidden>
          →
        </span>
      </Link>
    </li>
  );
}

/* ==========================================================================
 * Explore
 * ========================================================================== */

export function Explore() {
  const [users, setUsers] = useState<Awaited<ReturnType<typeof api.directory>>["users"] | null>(null);
  const [q, setQ] = useState("");

  useEffect(() => {
    api
      .directory()
      .then((d) => setUsers(d.users))
      .catch(() => setUsers([]));
  }, []);

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase().replace(/^@/, "");
    if (!needle) return users ?? [];
    return (users ?? []).filter(
      (u) => u.handle?.includes(needle) || u.bio?.toLowerCase().includes(needle) || u.displayName?.toLowerCase().includes(needle),
    );
  }, [users, q]);

  return (
    <main className="page wrap">
      <div className="page__head">
        <div>
          <Label tone="accent">explore</Label>
          <h1 className="h2 page__title">Open inboxes</h1>
        </div>
        <input
          className="input input--mono explore__search"
          placeholder="search @handle or bio"
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
      </div>

      <hr className="rule" />

      {users === null ? (
        <Spinner label="loading directory" />
      ) : filtered.length === 0 ? (
        <Empty title="No inboxes match" body="Try a different search, or be the first one listed." />
      ) : (
        <div className="cards">
          {filtered.map((u) => (
            <Link key={u.pubkey} to={`/u/${u.handle ?? u.pubkey}`} className="ucard card card--pad card--hover">
              <div className="row row--between">
                <span className="ucard__handle mono">@{u.handle ?? "anon"}</span>
                <span className="chip chip--accent">{formatCoin(u.priceBase, { maxFractionDigits: 2 })}</span>
              </div>
              <p className="ucard__bio muted">{u.bio || "No bio yet."}</p>
              <hr className="rule" />
              <div className="ucard__stats">
                <span>
                  <Label>answered</Label>
                  <b className="num">
                    {u.stats.answered}/{u.stats.received}
                  </b>
                </span>
                <span>
                  <Label>window</Label>
                  <b className="num">{u.replyWindowHours}h</b>
                </span>
              </div>
            </Link>
          ))}
        </div>
      )}
    </main>
  );
}

/* ==========================================================================
 * Ledger — the reconciliation page. A custodial escrow that will not show its
 * books is asking for trust it has not earned.
 * ========================================================================== */

export function Ledger() {
  const session = useSession();
  const [rec, setRec] = useState<Awaited<ReturnType<typeof api.reconciliation>> | null>(null);
  const [stats, setStats] = useState<Awaited<ReturnType<typeof api.stats>> | null>(null);

  useEffect(() => {
    api.reconciliation().then(setRec).catch(() => setRec(null));
    api.stats().then(setStats).catch(() => setStats(null));
  }, []);

  return (
    <main className="page wrap">
      <div className="page__head">
        <div>
          <Label tone="accent">transparency</Label>
          <h1 className="h2 page__title">The escrow books</h1>
        </div>
      </div>
      <hr className="rule" />

      <p className="lede" style={{ marginBottom: "2rem" }}>
        Unicity has no smart contracts, so an escrow has to be a wallet somebody runs. The invariant that keeps
        it honest is simple: the float must cover every open escrow plus the fees earned. Here it is, recomputed
        on load.
      </p>

      {!rec ? (
        <Spinner label="reading ledger" />
      ) : (
        <>
          <div className="figures figures--panel">
            <Stat label="open escrow" value={formatCoin(rec.openEscrowBase, { maxFractionDigits: 3 })} accent />
            <Stat label="fees earned" value={formatCoin(rec.feesEarnedBase, { maxFractionDigits: 3 })} />
            <Stat label="paid out" value={formatCoin(rec.paidOutBase, { maxFractionDigits: 3 })} />
            <Stat label="taken in" value={formatCoin(rec.escrowInBase, { maxFractionDigits: 3 })} />
          </div>

          <div className="card card--pad" style={{ marginTop: "2rem" }}>
            <Label tone="accent">the invariant</Label>
            <p className="ledger__eq mono">
              float ≥ open escrow + fees ={" "}
              <b className="accent">{formatCoin(rec.expectedFloatBase, { maxFractionDigits: 3 })}</b>
            </p>

            <div className="meta__row">
              <Label>reported float</Label>
              <span className="mono">
                {rec.actualFloatBase === null ? "not reported" : formatCoin(rec.actualFloatBase)}
              </span>
            </div>
            <div className="meta__row">
              <Label>status</Label>
              <span className={`chip ${rec.balanced === null ? "" : rec.balanced ? "chip--ok" : "chip--danger"}`}>
                {rec.balanced === null ? "unverifiable" : rec.balanced ? "balanced" : "SHORTFALL"}
              </span>
            </div>
            <div className="meta__row">
              <Label>rail</Label>
              <span className="mono">{rec.mode}</span>
            </div>

            {rec.mode === "simulated" && (
              <p className="muted" style={{ marginTop: "1rem" }}>
                The rail is <b>simulated</b>: the state machine, the ledger and this invariant are real, but no
                transfer is broadcast, so there is no float to report. Point the server at a bot wallet
                (<span className="mono">PAYOUT_MODE=sphere</span>) and this line fills in.
              </p>
            )}
          </div>

          {stats && (
            <div className="card card--pad" style={{ marginTop: "1.5rem" }}>
              <Label tone="accent">threads by state</Label>
              <div className="statebars">
                {Object.entries(stats.byState).map(([k, n]) => (
                  <div key={k} className="statebar">
                    <div className="row row--between">
                      <span className="mono">{k.toLowerCase()}</span>
                      <span className="num">{n}</span>
                    </div>
                    <div className="statebar__track">
                      <div
                        className="statebar__fill"
                        style={{
                          width: `${Math.max(3, (n / Math.max(1, Math.max(...Object.values(stats.byState)))) * 100)}%`,
                        }}
                      />
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          <p className="dim" style={{ marginTop: "1.5rem" }}>
            policy: <span className="mono">{session.config?.payoutPolicy}</span> · fee{" "}
            <span className="mono">{session.config ? session.config.feeBps / 100 : "—"}%</span> · checked{" "}
            <span className="mono">{relativeTime(rec.checkedAt)}</span>
          </p>
        </>
      )}
    </main>
  );
}
