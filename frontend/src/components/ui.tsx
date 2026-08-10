import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ButtonHTMLAttributes,
  type ReactNode,
} from "react";
import { STORAGE } from "../lib/config";
import { countdown } from "../lib/format";

/* ==========================================================================
 * Button
 * ========================================================================== */

type Variant = "primary" | "solid" | "ghost" | "danger" | "bare";
type Size = "sm" | "md" | "lg";

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
  loading?: boolean;
  block?: boolean;
}

export function Button({
  variant = "ghost",
  size = "md",
  loading = false,
  block = false,
  children,
  className = "",
  disabled,
  ...rest
}: ButtonProps) {
  const classes = [
    "btn",
    variant !== "bare" ? `btn--${variant}` : "",
    size !== "md" ? `btn--${size}` : "",
    block ? "btn--block" : "",
    className,
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <button className={classes} disabled={disabled || loading} {...rest}>
      {loading && <span className="btn__spin" aria-hidden />}
      {children}
    </button>
  );
}

/* ==========================================================================
 * Label — [BRACKETED MICRO TAG]
 * ========================================================================== */

export function Label({
  children,
  tone = "dim",
  bare = false,
  className = "",
}: {
  children: ReactNode;
  tone?: "dim" | "strong" | "accent";
  bare?: boolean;
  className?: string;
}) {
  const cls = [
    "label",
    tone === "accent" ? "label--accent" : tone === "strong" ? "label--strong" : "",
    bare ? "label--bare" : "",
    className,
  ]
    .filter(Boolean)
    .join(" ");
  return <span className={cls}>{children}</span>;
}

/* ==========================================================================
 * Theme
 * ========================================================================== */

type Theme = "dark" | "light";

const ThemeContext = createContext<{ theme: Theme; toggle: () => void } | null>(null);

export function useTheme() {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error("useTheme must be used inside <ThemeProvider>");
  return ctx;
}

function systemTheme(): Theme {
  if (typeof window === "undefined") return "dark";
  return window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [theme, setTheme] = useState<Theme>(() => {
    try {
      const saved = localStorage.getItem(STORAGE.theme);
      if (saved === "light" || saved === "dark") return saved;
    } catch {
      /* private mode */
    }
    return systemTheme();
  });

  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
    try {
      localStorage.setItem(STORAGE.theme, theme);
    } catch {
      /* private mode */
    }
  }, [theme]);

  const toggle = useCallback(() => setTheme((t) => (t === "dark" ? "light" : "dark")), []);
  const value = useMemo(() => ({ theme, toggle }), [theme, toggle]);

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function ThemeToggle() {
  const { theme, toggle } = useTheme();
  const next = theme === "dark" ? "light" : "dark";

  return (
    <button
      onClick={toggle}
      className="theme-toggle"
      aria-label={`Switch to ${next} mode`}
      title={`Switch to ${next} mode`}
    >
      <span className="theme-toggle__track">
        <span className="theme-toggle__thumb" />
      </span>
      <span className="theme-toggle__glyph theme-toggle__glyph--sun" aria-hidden>
        ☀
      </span>
      <span className="theme-toggle__glyph theme-toggle__glyph--moon" aria-hidden>
        ☾
      </span>
    </button>
  );
}

/* ==========================================================================
 * Toasts
 * ========================================================================== */

export type ToastTone = "info" | "ok" | "warn" | "danger";

interface Toast {
  id: number;
  tone: ToastTone;
  title: string;
  body?: string;
  sticky?: boolean;
}

const ToastContext = createContext<{
  push: (t: Omit<Toast, "id">) => void;
} | null>(null);

export function useToast() {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error("useToast must be used inside <ToastProvider>");
  return ctx;
}

let toastSeq = 0;

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<Toast[]>([]);

  const dismiss = useCallback((id: number) => {
    setItems((list) => list.filter((t) => t.id !== id));
  }, []);

  const push = useCallback(
    (t: Omit<Toast, "id">) => {
      const id = ++toastSeq;
      setItems((list) => [...list, { ...t, id }]);
      if (!t.sticky) setTimeout(() => dismiss(id), 6500);
    },
    [dismiss],
  );

  const value = useMemo(() => ({ push }), [push]);

  return (
    <ToastContext.Provider value={value}>
      {children}
      <div className="toasts" role="status" aria-live="polite">
        {items.map((t) => (
          <div key={t.id} className={`toast toast--${t.tone}`}>
            <div className="toast__bar" />
            <div className="toast__body">
              <div className="row row--between" style={{ gap: "1rem" }}>
                <Label tone={t.tone === "info" ? "strong" : "accent"}>{t.tone}</Label>
                <button className="toast__x" onClick={() => dismiss(t.id)} aria-label="Dismiss">
                  ✕
                </button>
              </div>
              <p className="toast__title">{t.title}</p>
              {t.body && <p className="toast__text">{t.body}</p>}
            </div>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

/* ==========================================================================
 * Countdown — ticks itself
 * ========================================================================== */

export function Countdown({ to, prefix = "" }: { to: number | null; prefix?: string }) {
  const [, force] = useState(0);

  useEffect(() => {
    if (!to) return;
    const id = setInterval(() => force((n) => n + 1), 1000);
    return () => clearInterval(id);
  }, [to]);

  if (!to) return null;
  const left = countdown(to);
  if (!left) return <span className="num dim">elapsed</span>;

  const urgent = to - Date.now() < 3600_000;
  return (
    <span className={`num ${urgent ? "accent" : ""}`}>
      {prefix}
      {left}
    </span>
  );
}

/* ==========================================================================
 * Misc primitives
 * ========================================================================== */

export function Rule({ className = "" }: { className?: string }) {
  return <hr className={`rule ${className}`} />;
}

export function Stat({
  label,
  value,
  hint,
  accent = false,
}: {
  label: string;
  value: ReactNode;
  hint?: ReactNode;
  accent?: boolean;
}) {
  return (
    <div className="stat">
      <Label>{label}</Label>
      <div className={`stat__value num ${accent ? "accent" : ""}`}>{value}</div>
      {hint && <div className="stat__hint">{hint}</div>}
    </div>
  );
}

export function Empty({ title, body, action }: { title: string; body?: string; action?: ReactNode }) {
  return (
    <div className="empty">
      <div className="empty__mark" aria-hidden>
        ◍
      </div>
      <p className="empty__title">{title}</p>
      {body && <p className="empty__body">{body}</p>}
      {action}
    </div>
  );
}

export function Spinner({ label = "Loading" }: { label?: string }) {
  return (
    <div className="loading">
      <span className="btn__spin" aria-hidden />
      <Label>{label}</Label>
    </div>
  );
}

export function Marquee({ items }: { items: string[] }) {
  const doubled = [...items, ...items];
  return (
    <div className="marquee-line" aria-hidden>
      <div className="marquee-line__track">
        {doubled.map((t, i) => (
          <span key={i} className="label label--bare marquee-line__item">
            {t}
            <span className="marquee-line__sep">✦</span>
          </span>
        ))}
      </div>
    </div>
  );
}
