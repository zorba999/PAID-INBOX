import { COIN } from "./config";

/* --------------------------------------------------------------------------
 * Amounts
 *
 * Every amount that crosses the Connect wire is in BASE UNITS as a string.
 * Convert at the dApp edge — never mid-flow, never in a component.
 * ------------------------------------------------------------------------ */

/** "1.5" -> "1500000000000000000". Throws on garbage. */
export function toBaseUnits(human: string, decimals: number = COIN.decimals): string {
  const trimmed = human.trim();
  if (!/^\d+(\.\d+)?$/.test(trimmed)) throw new Error(`Not a valid amount: "${human}"`);

  const [whole, frac = ""] = trimmed.split(".");
  if (frac.length > decimals) throw new Error(`Too many decimals (max ${decimals})`);

  const padded = frac.padEnd(decimals, "0");
  const combined = `${whole}${padded}`.replace(/^0+(?=\d)/, "");
  return combined === "" ? "0" : combined;
}

/** Non-throwing variant for live inputs. `null` means "invalid / mid-typing". */
export function safeToBaseUnits(human: string, decimals: number = COIN.decimals): string | null {
  try {
    return toBaseUnits(human, decimals);
  } catch {
    return null;
  }
}

/** "1500000000000000000" -> "1.5". Never uses Number(), so big values stay exact. */
export function fromBaseUnits(base: string | bigint, decimals: number = COIN.decimals): string {
  const s = typeof base === "bigint" ? base.toString() : String(base ?? "0");
  if (!/^\d+$/.test(s)) return "0";

  const padded = s.padStart(decimals + 1, "0");
  const whole = padded.slice(0, padded.length - decimals);
  const frac = padded.slice(padded.length - decimals).replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : whole;
}

/** Display helper: "1.5 UCT", trimmed to `maxFractionDigits`. */
export function formatCoin(
  base: string | bigint,
  opts: { decimals?: number; symbol?: string | null; maxFractionDigits?: number } = {},
): string {
  const { decimals = COIN.decimals, symbol = COIN.symbol, maxFractionDigits = 4 } = opts;
  const exact = fromBaseUnits(base, decimals);
  const [whole, frac] = exact.split(".");

  const groupedWhole = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  const cut = frac ? frac.slice(0, maxFractionDigits).replace(/0+$/, "") : "";
  const body = cut ? `${groupedWhole}.${cut}` : groupedWhole;

  return symbol ? `${body} ${symbol}` : body;
}

/* --------------------------------------------------------------------------
 * Identity
 * ------------------------------------------------------------------------ */

export function shortKey(key?: string | null, head = 6, tail = 4): string {
  if (!key) return "—";
  if (key.length <= head + tail + 1) return key;
  return `${key.slice(0, head)}…${key.slice(-tail)}`;
}

/** A nametag when there is one, otherwise a truncated pubkey. Never blank. */
export function displayName(id?: { nametag?: string | null; chainPubkey?: string | null } | null): string {
  if (!id) return "—";
  if (id.nametag) return id.nametag.startsWith("@") ? id.nametag : `@${id.nametag}`;
  return shortKey(id.chainPubkey);
}

export function normalizeHandle(raw: string): string {
  return raw.trim().replace(/^@+/, "").toLowerCase();
}

/* --------------------------------------------------------------------------
 * Time
 * ------------------------------------------------------------------------ */

const UNITS: [Intl.RelativeTimeFormatUnit, number][] = [
  ["second", 1000],
  ["minute", 60_000],
  ["hour", 3_600_000],
  ["day", 86_400_000],
  ["week", 604_800_000],
  ["month", 2_629_800_000],
  ["year", 31_557_600_000],
];

export function relativeTime(ts: number | string | Date): string {
  const time = new Date(ts).getTime();
  if (Number.isNaN(time)) return "—";

  const diff = time - Date.now();
  const abs = Math.abs(diff);

  let unit: Intl.RelativeTimeFormatUnit = "second";
  let ms = 1000;
  for (const [u, size] of UNITS) {
    if (abs >= size) {
      unit = u;
      ms = size;
    }
  }

  const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
  return rtf.format(Math.round(diff / ms), unit);
}

export function absoluteTime(ts: number | string | Date): string {
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString(undefined, {
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/** Countdown as "2d 04h" / "18h 22m" / "04m 09s". Empty string once elapsed. */
export function countdown(deadline: number): string {
  const left = deadline - Date.now();
  if (left <= 0) return "";

  const s = Math.floor(left / 1000);
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;

  const pad = (n: number) => String(n).padStart(2, "0");
  if (d > 0) return `${d}d ${pad(h)}h`;
  if (h > 0) return `${h}h ${pad(m)}m`;
  return `${pad(m)}m ${pad(sec)}s`;
}

export function pct(n: number): string {
  if (!Number.isFinite(n)) return "—";
  return `${Math.round(n * 100)}%`;
}

/** "3.4 h" / "12 min" — for median response times held in minutes. */
export function durationFromMinutes(min: number | null | undefined): string {
  if (min === null || min === undefined || !Number.isFinite(min)) return "—";
  if (min < 60) return `${Math.round(min)} min`;
  if (min < 60 * 48) return `${(min / 60).toFixed(1)} h`;
  return `${(min / 1440).toFixed(1)} d`;
}
