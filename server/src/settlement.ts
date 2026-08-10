import crypto from "node:crypto";
import { all, db, logEvent, type ThreadRow } from "./db.js";
import { env } from "./env.js";
import { payoutRail } from "./payout.js";

/* ==========================================================================
 * Settlement worker
 *
 * States it acts on:
 *   REPLIED   + dispute window elapsed  -> pay the winner of the policy
 *   DELIVERED + reply deadline elapsed  -> the silence branch of the policy
 *
 * Everything it does is idempotent: the ledger has UNIQUE(thread_id, kind) and
 * the payout rail derives a durable transfer id from (thread, kind), so a crash
 * mid-settlement resumes onto the same intent instead of paying twice.
 * ========================================================================== */

export function feeFor(amountBase: string): { fee: string; net: string } {
  const amount = BigInt(amountBase);
  const fee = (amount * BigInt(env.feeBps)) / 10_000n;
  return { fee: fee.toString(), net: (amount - fee).toString() };
}

/**
 * Who gets paid, given the thread outcome and the policy that was frozen onto
 * the thread when it was created. Policy is per-thread, never read live — a
 * setting change must not rewrite the deal a sender already agreed to.
 */
export function resolveOutcome(t: ThreadRow, replied: boolean): { payee: "recipient" | "sender" } {
  if (t.payout_policy === "silence") {
    return { payee: replied ? "sender" : "recipient" };
  }
  return { payee: replied ? "recipient" : "sender" };
}

function alreadySettled(threadId: string, kind: string): boolean {
  return !!db.prepare("SELECT 1 AS x FROM ledger WHERE thread_id = ? AND kind = ?").get(threadId, kind);
}

async function settle(t: ThreadRow, replied: boolean): Promise<void> {
  const { payee } = resolveOutcome(t, replied);
  const toRecipient = payee === "recipient";

  // A refund returns the full escrow; a payout takes the platform fee.
  const kind = toRecipient ? "payout" : "refund";
  const { fee, net } = toRecipient ? feeFor(t.price_base) : { fee: "0", net: t.price_base };
  const toPubkey = toRecipient ? t.recipient_pubkey : t.sender_pubkey;

  if (alreadySettled(t.id, kind)) return;

  const result = await payoutRail.send({
    threadId: t.id,
    kind: kind as "payout" | "refund",
    toPubkey,
    amountBase: net,
    memo: `paidinbox:${t.ref}`,
  });

  if (result.status === "failed") {
    logEvent(t.id, "settlement_failed", { kind, error: result.error });
    return; // stay in place; the next tick retries onto the same durable id
  }

  const now = Date.now();

  db.prepare(
    `INSERT OR IGNORE INTO ledger (id, thread_id, kind, pubkey, amount_base, transfer_id, status, at)
     VALUES (?, ?, ?, ?, ?, ?, 'settled', ?)`,
  ).run(crypto.randomUUID(), t.id, kind, toPubkey, net, result.transferId, now);

  if (toRecipient && fee !== "0") {
    db.prepare(
      `INSERT OR IGNORE INTO ledger (id, thread_id, kind, pubkey, amount_base, transfer_id, status, at)
       VALUES (?, ?, 'fee', 'platform', ?, ?, 'settled', ?)`,
    ).run(crypto.randomUUID(), t.id, fee, result.transferId, now);
  }

  const nextState = toRecipient ? "RELEASED" : "REFUNDED";

  db.prepare(
    `UPDATE threads
        SET state = ?, settled_at = ?, settlement_transfer_id = ?, fee_base = ?, payee_pubkey = ?, updated_at = ?
      WHERE id = ?`,
  ).run(nextState, now, result.transferId, fee, toPubkey, now, t.id);

  logEvent(t.id, nextState.toLowerCase(), {
    payee,
    net,
    fee,
    transferId: result.transferId,
    simulated: result.simulated,
  });
}

export async function runSettlementTick(): Promise<{ settled: number; expired: number }> {
  const now = Date.now();
  let settled = 0;
  let expired = 0;

  // 1. Replies whose dispute window has closed.
  const replied = all<ThreadRow>(
    "SELECT * FROM threads WHERE state = 'REPLIED' AND confirm_until IS NOT NULL AND confirm_until <= ?",
    now,
  );

  for (const t of replied) {
    await settle(t, true);
    settled += 1;
  }

  // 2. Escrows whose reply deadline passed with no reply.
  const silent = all<ThreadRow>(
    `SELECT * FROM threads
        WHERE state IN ('DELIVERED','ESCROWED') AND deadline_at IS NOT NULL AND deadline_at <= ?`,
    now,
  );

  for (const t of silent) {
    db.prepare("UPDATE threads SET state = 'EXPIRED', updated_at = ? WHERE id = ?").run(now, t.id);
    logEvent(t.id, "expired", { deadline: t.deadline_at });
    await settle({ ...t, state: "EXPIRED" }, false);
    expired += 1;
  }

  return { settled, expired };
}

/* --------------------------------------------------------- reconciliation
 * The red line for a custodial escrow:
 *     bot float  ==  open escrows  +  fees earned
 * When the rail cannot report a balance (simulated), we still publish both
 * sides of the equation so the ledger stays auditable.
 * ----------------------------------------------------------------------- */

export async function reconcile() {
  // Every total is summed in BigInt, never by SQL: SUM() on an 18-decimals
  // amount returns a float and silently loses the low digits.
  const open = all<{ price_base: string }>(
    "SELECT price_base FROM threads WHERE state IN ('ESCROWED','DELIVERED','REPLIED','DISPUTED')",
  );

  const fees = all<{ amount_base: string }>("SELECT amount_base FROM ledger WHERE kind = 'fee'");

  const paid = all<{ amount_base: string }>("SELECT amount_base FROM ledger WHERE kind IN ('payout','refund')");

  const escrowIn = all<{ amount_base: string }>("SELECT amount_base FROM ledger WHERE kind = 'escrow_in'");

  const sum = (rows: Array<{ price_base?: string; amount_base?: string }>) =>
    rows.reduce((acc, r) => acc + BigInt(r.price_base ?? r.amount_base ?? "0"), 0n);

  const openTotal = sum(open);
  const feeTotal = sum(fees);
  const paidTotal = sum(paid);
  const inTotal = sum(escrowIn);

  const expected = openTotal + feeTotal;
  const actual = await payoutRail.balance();

  return {
    mode: payoutRail.mode,
    coinId: env.coinId,
    openEscrowBase: openTotal.toString(),
    feesEarnedBase: feeTotal.toString(),
    paidOutBase: paidTotal.toString(),
    escrowInBase: inTotal.toString(),
    expectedFloatBase: expected.toString(),
    actualFloatBase: actual,
    /** null when the rail cannot report a float (simulated mode). */
    balanced: actual === null ? null : BigInt(actual) >= expected,
    checkedAt: Date.now(),
  };
}

let timer: NodeJS.Timeout | null = null;

export function startSettlementLoop(): void {
  if (timer) return;
  const tick = () => {
    runSettlementTick().catch((err) => {
      console.error("[settlement] tick failed:", err);
    });
  };
  tick();
  timer = setInterval(tick, env.settlementIntervalMs);
}

export function stopSettlementLoop(): void {
  if (timer) clearInterval(timer);
  timer = null;
}
