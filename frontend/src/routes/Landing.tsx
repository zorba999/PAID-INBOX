import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { api, type PublicUser } from "../lib/api";
import { durationFromMinutes, formatCoin, pct } from "../lib/format";
import { useSession } from "../app/SessionProvider";
import { useWallet } from "../wallet/WalletProvider";
import { Button, Label, Marquee, Rule } from "../components/ui";
import { ConnectPanel } from "../components/wallet-ui";

const STEPS = [
  {
    n: "01",
    title: "Name your price",
    body: "You decide what a stranger pays to land in your inbox, and how long they wait for an answer.",
    tag: "recipient",
  },
  {
    n: "02",
    title: "They pay into escrow",
    body: "The sender's wallet funds the escrow, then sends the message itself — encrypted, straight from their key to yours.",
    tag: "sender",
  },
  {
    n: "03",
    title: "Reply and it is yours",
    body: "Answer inside the window and the escrow releases to you. Stay silent and it goes back to the sender, in full.",
    tag: "settlement",
  },
];

export function Landing() {
  const wallet = useWallet();
  const session = useSession();
  const [dir, setDir] = useState<PublicUser[]>([]);
  const [stats, setStats] = useState<{ users: number; volumeBase: string } | null>(null);
  const heroRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    api.directory().then((d) => setDir(d.users.slice(0, 6))).catch(() => setDir([]));
    api.stats().then((s) => setStats({ users: s.users, volumeBase: s.volumeBase })).catch(() => setStats(null));
  }, []);

  // Parallax on the hero word — small, physical, and off when reduced motion.
  useEffect(() => {
    const el = heroRef.current;
    if (!el) return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;

    let raf = 0;
    const onScroll = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        const y = Math.min(window.scrollY, 700);
        el.style.setProperty("--parallax", `${y * 0.16}px`);
        el.style.setProperty("--fade", String(Math.max(0, 1 - y / 520)));
      });
    };
    window.addEventListener("scroll", onScroll, { passive: true });
    onScroll();
    return () => {
      window.removeEventListener("scroll", onScroll);
      cancelAnimationFrame(raf);
    };
  }, []);

  const policy = session.config?.payoutPolicy ?? "reply";

  return (
    <main className="landing">
      {/* ---------------------------------------------------------- hero */}
      <section className="hero">
        <div className="hero__grid" aria-hidden />
        <div className="wrap hero__inner" ref={heroRef}>
          <Label tone="accent" className="hero__eyebrow">
            paid inbox · unicity {session.config?.network ?? "testnet2"}
          </Label>

          <h1 className="hero__title display">
            <span className="hero__line">ATTENTION</span>
            <span className="hero__line hero__line--indent">
              HAS A <em className="hero__em">PRICE</em>
            </span>
          </h1>

          <div className="hero__meta">
            <p className="lede hero__lede">
              Anyone can reach you — if they pay. Reply inside your window and the money is yours. Ignore it
              and the sender gets every unit back. Spam stops being free.
            </p>

            <div className="hero__cta">
              {wallet.isConnected && session.me ? (
                <>
                  <Link to="/inbox" className="btn btn--primary btn--lg">
                    Open my inbox
                  </Link>
                  <Link to="/compose" className="btn btn--ghost btn--lg">
                    Send a paid message
                  </Link>
                </>
              ) : (
                <ConnectPanel />
              )}
            </div>
          </div>

          <div className="hero__scroll" aria-hidden>
            <span className="label label--bare">[scroll]</span>
            <span className="hero__scrollbar" />
          </div>
        </div>
      </section>

      {/* ------------------------------------------------------- marquee */}
      <div className="band">
        <Marquee
          items={[
            "PAY TO REACH",
            "REPLY TO EARN",
            "ESCROW ON UNICITY",
            "SPHERE CONNECT 2.1",
            "NO SPAM, NO FREE RIDE",
            "TESTNET2",
          ]}
        />
      </div>

      {/* --------------------------------------------------------- steps */}
      <section className="section">
        <div className="wrap">
          <div className="section__head">
            <Label tone="accent">how it works</Label>
            <h2 className="h2 section__title">
              Three moves. One of them
              <br />
              costs money.
            </h2>
          </div>

          <div className="steps">
            {STEPS.map((s) => (
              <article key={s.n} className="step">
                <div className="step__n display">{s.n}</div>
                <div className="step__body">
                  <Label>{s.tag}</Label>
                  <h3 className="h3 step__title">{s.title}</h3>
                  <p className="muted">{s.body}</p>
                </div>
              </article>
            ))}
          </div>

          <div className="deal card card--pad">
            <Label tone="accent">the deal, in one line</Label>
            <p className="deal__line">
              {policy === "reply" ? (
                <>
                  A reply pays the <em>recipient</em>. Silence refunds the <em>sender</em>.
                </>
              ) : (
                <>
                  Silence pays the <em>recipient</em>. A reply refunds the <em>sender</em>.
                </>
              )}
            </p>
            <p className="muted deal__note">
              The policy is frozen onto every thread the moment it is created, so changing a setting later can
              never rewrite a deal somebody already agreed to.
            </p>
          </div>
        </div>
      </section>

      {/* --------------------------------------------------------- stats */}
      <section className="section section--tight">
        <div className="wrap">
          <Rule />
          <div className="figures">
            <Figure k="inboxes" v={stats ? String(stats.users) : "—"} />
            <Figure k="escrowed volume" v={stats ? formatCoin(stats.volumeBase, { maxFractionDigits: 2 }) : "—"} />
            <Figure k="platform fee" v={session.config ? `${session.config.feeBps / 100}%` : "—"} />
            <Figure k="dispute window" v={session.config ? `${session.config.disputeWindowHours}h` : "—"} />
          </div>
          <Rule />
        </div>
      </section>

      {/* ----------------------------------------------------- directory */}
      <section className="section">
        <div className="wrap">
          <div className="section__head section__head--row">
            <div>
              <Label tone="accent">open inboxes</Label>
              <h2 className="h2 section__title">Who is listening</h2>
            </div>
            <Link to="/explore" className="btn btn--ghost btn--sm">
              See all
            </Link>
          </div>

          {dir.length === 0 ? (
            <p className="muted">
              No inboxes yet. Connect a wallet, set a price, and yours is the first one on this page.
            </p>
          ) : (
            <div className="cards">
              {dir.map((u) => (
                <Link key={u.pubkey} to={`/u/${u.handle ?? u.pubkey}`} className="ucard card card--pad card--hover">
                  <div className="row row--between">
                    <span className="ucard__handle mono">@{u.handle ?? "anon"}</span>
                    <span className="chip chip--accent">{formatCoin(u.priceBase, { maxFractionDigits: 2 })}</span>
                  </div>
                  <p className="ucard__bio muted">{u.bio || "No bio yet."}</p>
                  <hr className="rule" />
                  <div className="ucard__stats">
                    <span>
                      <Label>reply rate</Label>
                      <b className="num">{u.stats.replyRate === null ? "—" : pct(u.stats.replyRate)}</b>
                    </span>
                    <span>
                      <Label>median</Label>
                      <b className="num">{durationFromMinutes(u.stats.medianReplyMinutes)}</b>
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
        </div>
      </section>

      {/* -------------------------------------------------------- honest */}
      <section className="section">
        <div className="wrap">
          <div className="honest">
            <div className="honest__side">
              <Label tone="accent">what to know</Label>
              <h2 className="h2 section__title">
                The escrow is
                <br />
                custodial.
              </h2>
            </div>
            <div className="honest__body">
              <p className="lede">
                Unicity has no smart contracts, so the money sits with a bot wallet we run for the length of
                the reply window. That is a trust assumption and we are not going to hide it behind a diagram.
              </p>
              <ul className="honest__list">
                <li>
                  <Label>1</Label> The float, the open escrows and the fees are published on the{" "}
                  <Link to="/ledger" className="tlink">
                    ledger page
                  </Link>
                  , recomputed on every load.
                </li>
                <li>
                  <Label>2</Label> Message bodies never reach our server. The DM goes wallet to wallet,
                  encrypted; we store an id and a hash.
                </li>
                <li>
                  <Label>3</Label> A reply is proven by a signature from the recipient's own key, not by us
                  reading anything.
                </li>
              </ul>
            </div>
          </div>
        </div>
      </section>

      {/* ----------------------------------------------------------- cta */}
      <section className="cta">
        <div className="wrap cta__inner">
          <h2 className="cta__title display">
            PUT A PRICE
            <br />
            ON YOUR TIME
          </h2>
          {wallet.isConnected && session.me ? (
            <Link to="/settings" className="btn btn--primary btn--lg">
              Set your price
            </Link>
          ) : (
            <div className="cta__connect">
              <Button variant="primary" size="lg" onClick={wallet.connect} loading={wallet.isConnecting}>
                Connect Sphere
              </Button>
              <Button variant="ghost" size="lg" onClick={wallet.connectDemo}>
                Try the demo
              </Button>
            </div>
          )}
        </div>
      </section>
    </main>
  );
}

function Figure({ k, v }: { k: string; v: string }) {
  return (
    <div className="figure">
      <div className="figure__v num">{v}</div>
      <Label>{k}</Label>
    </div>
  );
}
