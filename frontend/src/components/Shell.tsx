import { useEffect, useState, type ReactNode } from "react";
import { Link, NavLink, useLocation } from "react-router-dom";
import { useWallet } from "../wallet/WalletProvider";
import { useSession } from "../app/SessionProvider";
import { api } from "../lib/api";
import { Label, ThemeToggle } from "./ui";
import { ConnectPanel, DemoBanner, LockBanner } from "./wallet-ui";

const NAV = [
  { to: "/inbox", label: "inbox" },
  { to: "/sent", label: "sent" },
  { to: "/explore", label: "explore" },
  { to: "/settings", label: "settings" },
];

export function Header() {
  const session = useSession();
  const [scrolled, setScrolled] = useState(false);
  const { pathname } = useLocation();

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 12);
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  return (
    <header className={`hdr ${scrolled ? "hdr--stuck" : ""}`}>
      <div className="hdr__inner wrap">
        <Link to="/" className="brand" aria-label="Paid Inbox — home">
          <span className="brand__mark" aria-hidden />
          <span className="brand__text">
            PAID<span className="brand__slash">/</span>INBOX
          </span>
        </Link>

        <nav className="hdr__nav" aria-label="Main">
          {NAV.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              className={({ isActive }) => `navlink ${isActive ? "navlink--on" : ""}`}
            >
              <span className="navlink__inner">
                <span className="navlink__a">[{item.label}]</span>
                <span className="navlink__b" aria-hidden>
                  [{item.label}]
                </span>
              </span>
            </NavLink>
          ))}
        </nav>

        <div className="hdr__right">
          {session.me && pathname !== "/compose" && (
            <Link to="/compose" className="btn btn--solid btn--sm hdr__cta">
              Send a paid message
            </Link>
          )}
          <ThemeToggle />
          <ConnectPanel compact />
        </div>
      </div>
    </header>
  );
}

export function Footer() {
  const session = useSession();
  const [health, setHealth] = useState<string>("…");

  useEffect(() => {
    api
      .stats()
      .then((s) => setHealth(`${s.users} inboxes`))
      .catch(() => setHealth("api offline"));
  }, []);

  return (
    <footer className="ftr">
      <hr className="rule" />
      <div className="wrap ftr__inner">
        <div className="ftr__col">
          <Label tone="strong">paid inbox</Label>
          <p className="muted ftr__blurb">
            Escrowed messaging on Unicity. Pay to reach an inbox; the escrow settles on the reply.
          </p>
        </div>

        <div className="ftr__col">
          <Label>network</Label>
          <ul className="ftr__list mono">
            <li>{session.config?.network ?? "testnet2"}</li>
            <li>{session.config?.coinSymbol ?? "UCT"}</li>
            <li>connect 2.1</li>
          </ul>
        </div>

        <div className="ftr__col">
          <Label>escrow</Label>
          <ul className="ftr__list mono">
            <li>rail: {session.config?.payoutMode ?? "—"}</li>
            <li>fee: {session.config ? session.config.feeBps / 100 : "—"}%</li>
            <li>
              <Link to="/ledger" className="tlink">
                public ledger
              </Link>
            </li>
          </ul>
        </div>

        <div className="ftr__col">
          <Label>status</Label>
          <ul className="ftr__list mono">
            <li>{health}</li>
            <li>
              <a
                className="tlink"
                href="https://github.com/unicity-sphere/sphere-sdk"
                target="_blank"
                rel="noreferrer noopener"
              >
                sphere-sdk ↗
              </a>
            </li>
          </ul>
        </div>
      </div>

      <div className="wrap ftr__base">
        <span className="label label--bare">© {new Date().getFullYear()} paid inbox</span>
        <span className="label label--bare">built on unicity</span>
      </div>
    </footer>
  );
}

/** Wraps every authenticated page: banners first, then content. */
export function Page({
  title,
  eyebrow,
  actions,
  children,
}: {
  title: string;
  eyebrow?: string;
  actions?: ReactNode;
  children: ReactNode;
}) {
  const wallet = useWallet();
  const session = useSession();

  return (
    <main className="page wrap">
      <DemoBanner />
      <LockBanner />

      <div className="page__head">
        <div>
          {eyebrow && <Label tone="accent">{eyebrow}</Label>}
          <h1 className="h2 page__title">{title}</h1>
        </div>
        {actions && <div className="page__actions">{actions}</div>}
      </div>

      <hr className="rule" />

      {!wallet.isConnected || !session.me ? (
        <div className="gate">
          <p className="lede">
            Connect a Sphere wallet to continue. Your key is your account — there is nothing else to sign up
            with.
          </p>
          <ConnectPanel />
        </div>
      ) : (
        children
      )}
    </main>
  );
}
