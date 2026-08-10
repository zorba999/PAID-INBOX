import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { api, type PublicUser } from "../lib/api";
import { durationFromMinutes, formatCoin, pct, shortKey } from "../lib/format";
import { useSession } from "../app/SessionProvider";
import { Empty, Label, Spinner } from "../components/ui";

/* ==========================================================================
 * Public inbox page.
 *
 * Deliberately readable with no wallet connected: this is the link people
 * share, and asking a stranger to connect before they can even see the price
 * kills the whole funnel.
 * ========================================================================== */

export function Profile() {
  const { handle = "" } = useParams();
  const session = useSession();
  const [user, setUser] = useState<PublicUser | null>(null);
  const [missing, setMissing] = useState(false);

  useEffect(() => {
    setUser(null);
    setMissing(false);
    api
      .profile(handle)
      .then((r) => setUser(r.user))
      .catch(() => setMissing(true));
  }, [handle]);

  if (missing) {
    return (
      <main className="page wrap">
        <Empty
          title={`No inbox at @${handle.replace(/^@/, "")}`}
          body="Nobody has claimed this handle yet."
          action={
            <Link to="/explore" className="btn btn--ghost btn--sm">
              Explore open inboxes
            </Link>
          }
        />
      </main>
    );
  }

  if (!user) {
    return (
      <main className="page wrap">
        <Spinner label="loading inbox" />
      </main>
    );
  }

  const isMe = session.me?.pubkey === user.pubkey;

  return (
    <main className="profile">
      <section className="profile__hero">
        <div className="wrap">
          <Label tone="accent">paid inbox</Label>
          <h1 className="profile__handle display">@{user.handle ?? "anon"}</h1>
          {user.displayName && <p className="profile__name">{user.displayName}</p>}
          {user.bio && <p className="lede profile__bio">{user.bio}</p>}

          <div className="profile__price">
            <div>
              <Label>price to reach</Label>
              <div className="profile__amount num">{formatCoin(user.priceBase)}</div>
            </div>
            <div className="profile__cta">
              {isMe ? (
                <Link to="/settings" className="btn btn--ghost btn--lg">
                  Edit my inbox
                </Link>
              ) : user.isOpen ? (
                <Link to={`/compose?to=${user.handle ?? user.pubkey}`} className="btn btn--primary btn--lg">
                  Send a paid message
                </Link>
              ) : (
                <span className="chip chip--warn">inbox closed</span>
              )}
            </div>
          </div>
        </div>
      </section>

      <hr className="rule" />

      <section className="wrap profile__stats">
        <Metric
          k="reply rate"
          v={user.stats.replyRate === null ? "—" : pct(user.stats.replyRate)}
          note="of concluded threads"
        />
        <Metric k="median reply" v={durationFromMinutes(user.stats.medianReplyMinutes)} note="time to answer" />
        <Metric k="answered" v={`${user.stats.answered}`} note={`of ${user.stats.received} received`} />
        <Metric k="window" v={`${user.replyWindowHours}h`} note="before the refund" />
      </section>

      <hr className="rule" />

      <section className="wrap profile__deal">
        <div>
          <Label tone="accent">the deal</Label>
          <h2 className="h3" style={{ marginTop: "0.6rem" }}>
            {session.config?.payoutPolicy === "silence" ? (
              <>They keep it by staying silent. A reply refunds you.</>
            ) : (
              <>
                They earn {formatCoin(user.priceBase)} by replying. Silence refunds you in full, automatically,
                after {user.replyWindowHours} hours.
              </>
            )}
          </h2>
        </div>
        <p className="muted">
          Your message is encrypted end to end — it goes from your wallet to theirs, and this app never sees it.
          The escrow settles on a signature from their key, not on anyone reading your words.
        </p>
        <div className="profile__key">
          <Label>key</Label>
          <span className="mono">{shortKey(user.pubkey, 10, 8)}</span>
        </div>
      </section>
    </main>
  );
}

function Metric({ k, v, note }: { k: string; v: string; note: string }) {
  return (
    <div className="metric">
      <Label>{k}</Label>
      <div className="metric__v num">{v}</div>
      <div className="dim metric__note">{note}</div>
    </div>
  );
}
