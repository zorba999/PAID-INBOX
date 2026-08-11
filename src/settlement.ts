import crypto from "node:crypto";
import { all, logEvent, normalizeThread, run, type ThreadRow } from "./db.js";
import { env } from "./env.js";
import { payoutRail } from "./payout.js";

/* ==========================================================================
 * Settlement
 *
 *   REPLIED   + dispute window elapsed  -> pay the winner of the policy
 *   DELIVERED + reply deadline elapsed  -> the silence branch of the policy
 *
 * There is no timer. A serverless deployment has no process to hold one, so a
 * tick runs opportunistically on API traffic (throttled, non-blocking) and a
 * cron endpoint covers a deployment with no traffic at all. Both call the same
 * function, and it is safe to call from either at any moment: the ledger's
 * UNIQUE(thread_id, kind) is the guarantee, and settle() checks it first.
 * ========================================================================== */

export function feeFor(amountBase: string): { fee: string; net: string } {
  const amount = BigInt(amountBase);
  const fee = (amount * BigInt(env.feeBps)) / 10_000n;
  return { fee: fee.toString(), net: (amount - fee).toString() };
}

/**
 * Who gets paid, given the outcome and the policy frozen onto the thread when
 * it was created. Policy is per-thread and never read live: a settings change
 * must not rewrite a deal the sender already agreed to.
 */
export function resolveOutcome(t: ThreadRow, replied: boolean): { payee: "recipient" | "sender" } {
  if (t.payout_policy === "silence") return { payee: replied ? "sender" : "recipient" };
  return { payee: replied ? "recipient" : "sender" };
}

async function alreadySettled(threadId: string, kind: string): Promise<boolean> {
  const rows = await all<{ x: number }>(
    "SELECT 1 AS x FROM ledger WHERE thread_id = $1 AND kind = $2",
    threadId,
    kind,
  );
  return rows.length > 0;
}

async function settle(t: ThreadRow, replied: boolean): Promise<void> {
  const { payee } = resolveOutcome(t, replied);
  const toRecipient = payee === "recipient";

  // A refund returns the whole escrow; a payout takes the platform fee.
  const kind = toRecipient ? "payout" : "refund";
  const { fee, net } = toRecipient ? feeFor(t.price_base) : { fee: "0", net: t.price_base };
  const toPubkey = toRecipient ? t.recipient_pubkey : t.sender_pubkey;

  if (await alreadySettled(t.id, kind)) return;

  const result = await payoutRail.send({
    threadId: t.id,
    kind: kind as "payout" | "refund",
    toPubkey,
    amountBase: net,
    memo: `paidinbox:${t.ref}`,
  });

  if (result.status === "failed") {
    await logEvent(t.id, "settlement_failed", { kind, error: result.error });
    return; // stay put; the next tick retries
  }

  const now = Date.now();

  await run(
    `INSERT INTO ledger (id, thread_id, kind, pubkey, amount_base, transfer_id, status, at)
     VALUES ($1, $2, $3, $4, $5, $6, 'settled', $7)
     ON CONFLICT (thread_id, kind) DO NOTHING`,
    crypto.randomUUID(),
    t.id,
    kind,
    toPubkey,
    net,
    result.transferId,
    now,
  );

  if (toRecipient && fee !== "0") {
    await run(
      `INSERT INTO ledger (id, thread_id, kind, pubkey, amount_base, transfer_id, status, at)
       VALUES ($1, $2, 'fee', 'platform', $3, $4, 'settled', $5)
       ON CONFLICT (thread_id, kind) DO NOTHING`,
      crypto.randomUUID(),
      t.id,
      fee,
      result.transferId,
      now,
    );
  }

  const nextState = toRecipient ? "RELEASED" : "REFUNDED";

  await run(
    `UPDATE threads
        SET state = $1, settled_at = $2, settlement_transfer_id = $3, fee_base = $4,
            payee_pubkey = $5, updated_at = $6
      WHERE id = $7`,
    nextState,
    now,
    result.transferId,
    fee,
    toPubkey,
    now,
    t.id,
  );

  await logEvent(t.id, nextState.toLowerCase(), {
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

  const replied = (
    await all<ThreadRow>(
      "SELECT * FROM threads WHERE state = 'REPLIED' AND confirm_until IS NOT NULL AND confirm_until <= $1",
      now,
    )
  ).map(normalizeThread);

  for (const t of replied) {
    await settle(t, true);
    settled += 1;
  }

  const silent = (
    await all<ThreadRow>(
      `SELECT * FROM threads
        WHERE state IN ('DELIVERED','ESCROWED') AND deadline_at IS NOT NULL AND deadline_at <= $1`,
      now,
    )
  ).map(normalizeThread);

  for (const t of silent) {
    await run("UPDATE threads SET state = 'EXPIRED', updated_at = $1 WHERE id = $2", now, t.id);
    await logEvent(t.id, "expired", { deadline: t.deadline_at });
    await settle({ ...t, state: "EXPIRED" }, false);
    expired += 1;
  }

  return { settled, expired };
}

/* ---------------------------------------------------- opportunistic ticking
 * Throttled in memory. A warm lambda skips most requests; a cold one runs once.
 * Deliberately not awaited by the request that triggers it.
 * ----------------------------------------------------------------------- */

let lastTick = 0;
let inFlight = false;

export function maybeSettleInBackground(): void {
  const now = Date.now();
  if (inFlight || now - lastTick < env.settlementMinIntervalMs) return;
  lastTick = now;
  inFlight = true;

  void runSettlementTick()
    .catch((err) => console.error("[settlement] tick failed:", err))
    .finally(() => {
      inFlight = false;
    });
}

/* --------------------------------------------------------- reconciliation
 * The red line for a custodial escrow:
 *     float  >=  open escrows  +  fees earned
 * ----------------------------------------------------------------------- */

export async function reconcile() {
  // Every total is summed in BigInt, never by SQL: SUM() on an 18-decimals
  // amount goes through a float and silently drops the low digits.
  const open = await all<{ price_base: string }>(
    "SELECT price_base FROM threads WHERE state IN ('ESCROWED','DELIVERED','REPLIED','DISPUTED')",
  );
  const fees = await all<{ amount_base: string }>("SELECT amount_base FROM ledger WHERE kind = 'fee'");
  const paid = await all<{ amount_base: string }>(
    "SELECT amount_base FROM ledger WHERE kind IN ('payout','refund')",
  );
  const escrowIn = await all<{ amount_base: string }>(
    "SELECT amount_base FROM ledger WHERE kind = 'escrow_in'",
  );

  const sum = (rows: Array<{ price_base?: string; amount_base?: string }>) =>
    rows.reduce((acc, r) => acc + BigInt(r.price_base ?? r.amount_base ?? "0"), 0n);

  const openTotal = sum(open);
  const feeTotal = sum(fees);
  const expected = openTotal + feeTotal;
  const actual = await payoutRail.balance();

  return {
    mode: payoutRail.mode,
    coinId: env.coinId,
    openEscrowBase: openTotal.toString(),
    feesEarnedBase: feeTotal.toString(),
    paidOutBase: sum(paid).toString(),
    escrowInBase: sum(escrowIn).toString(),
    expectedFloatBase: expected.toString(),
    actualFloatBase: actual,
    /** null when the rail cannot report a float (simulated mode). */
    balanced: actual === null ? null : BigInt(actual) >= expected,
    checkedAt: Date.now(),
  };
}
