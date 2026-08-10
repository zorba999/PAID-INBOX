import type { ThreadState } from "../lib/api";

const MAP: Record<ThreadState, { label: string; tone: "" | "ok" | "warn" | "danger" | "accent" }> = {
  PAYING: { label: "awaiting payment", tone: "warn" },
  PENDING_RECONCILE: { label: "reconciling", tone: "danger" },
  ESCROWED: { label: "escrowed", tone: "accent" },
  DELIVERED: { label: "awaiting reply", tone: "accent" },
  REPLIED: { label: "replied", tone: "ok" },
  RELEASED: { label: "released", tone: "ok" },
  EXPIRED: { label: "expired", tone: "" },
  REFUNDED: { label: "refunded", tone: "" },
  DISPUTED: { label: "disputed", tone: "danger" },
};

export function StateChip({ state }: { state: ThreadState }) {
  const s = MAP[state] ?? { label: state.toLowerCase(), tone: "" as const };
  return (
    <span className={`chip ${s.tone ? `chip--${s.tone}` : ""}`}>
      <span className="dot" />
      {s.label}
    </span>
  );
}
