import crypto from "node:crypto";
import { env } from "./env.js";

/* ==========================================================================
 * Payout rail
 *
 * The escrow state machine, the ledger and the reconciliation invariant are
 * real in both modes. What differs is whether the transfer is broadcast.
 *
 *   simulated — journals the transfer and returns a synthetic id. No keys, no
 *               network. This is the default so the app runs end to end out of
 *               the box, and NOTHING it reports is presented as on-chain.
 *   sphere    — a real bot wallet on testnet2 settles with payments.send().
 *               Requires BOT_MNEMONIC + WALLET_API_URL.
 *
 * Idempotency is the caller's job (unique constraint on ledger(thread_id,kind))
 * AND ours: `transferId` is derived from the thread + kind, so a crashed run
 * that resumes reuses the same durable intent id instead of paying twice.
 * ========================================================================== */

export interface PayoutRequest {
  threadId: string;
  kind: "payout" | "refund";
  toPubkey: string;
  /** Nametag or DIRECT:// address. Falls back to the pubkey when absent. */
  toAddress?: string | null;
  amountBase: string;
  memo?: string;
}

export interface PayoutResult {
  transferId: string;
  status: "settled" | "pending" | "failed";
  deliveryPending: boolean;
  simulated: boolean;
  error?: string;
}

export interface PayoutRail {
  readonly mode: "simulated" | "sphere";
  ready(): Promise<boolean>;
  /** Bot float, base units. `null` when the rail cannot report one. */
  balance(): Promise<string | null>;
  send(req: PayoutRequest): Promise<PayoutResult>;
}

/** Stable per (thread, kind) so a retry after a crash reuses the same id. */
function durableTransferId(threadId: string, kind: string): string {
  return crypto.createHash("sha256").update(`${threadId}:${kind}`).digest("hex").slice(0, 32);
}

/* ------------------------------------------------------------- simulated */

class SimulatedRail implements PayoutRail {
  readonly mode = "simulated" as const;

  async ready(): Promise<boolean> {
    return true;
  }

  async balance(): Promise<string | null> {
    return null;
  }

  async send(req: PayoutRequest): Promise<PayoutResult> {
    return {
      transferId: `sim-${durableTransferId(req.threadId, req.kind)}`,
      status: "settled",
      deliveryPending: false,
      simulated: true,
    };
  }
}

/* ---------------------------------------------------------------- sphere */

class SphereRail implements PayoutRail {
  readonly mode = "sphere" as const;
  private sphere: any = null;
  private booting: Promise<void> | null = null;

  private async boot(): Promise<void> {
    if (this.sphere) return;
    if (this.booting) return this.booting;

    this.booting = (async () => {
      if (!env.botMnemonic) throw new Error("BOT_MNEMONIC is required for PAYOUT_MODE=sphere");
      // Since sphere-sdk 0.14 there is no own-storage custody: Sphere.init throws
      // INVALID_CONFIG without a wallet-api composition.
      if (!env.walletApiUrl) throw new Error("WALLET_API_URL is required for PAYOUT_MODE=sphere");

      const sdk: any = await import("@unicitylabs/sphere-sdk");
      const nodeImpl: any = await import("@unicitylabs/sphere-sdk/impl/nodejs");
      const walletApi: any = await import("@unicitylabs/sphere-sdk/impl/shared/wallet-api");

      const providers = nodeImpl.createNodeProviders({ network: env.network });
      const composed = walletApi.createWalletApiProviders({
        ...providers,
        walletApiUrl: env.walletApiUrl,
      });

      this.sphere = await sdk.Sphere.init({
        mnemonic: env.botMnemonic,
        network: env.network,
        providers: composed,
      });
    })();

    try {
      await this.booting;
    } finally {
      this.booting = null;
    }
  }

  async ready(): Promise<boolean> {
    try {
      await this.boot();
      return true;
    } catch {
      return false;
    }
  }

  async balance(): Promise<string | null> {
    try {
      await this.boot();
      const assets = await this.sphere.payments.assets();
      const match = (assets as Array<{ coinId: string; amount: string }>).find(
        (a) => a.coinId?.toLowerCase() === env.coinId,
      );
      return match?.amount ?? "0";
    } catch {
      return null;
    }
  }

  async send(req: PayoutRequest): Promise<PayoutResult> {
    const transferId = durableTransferId(req.threadId, req.kind);
    try {
      await this.boot();
      const result = await this.sphere.payments.send({
        to: req.toAddress ?? req.toPubkey,
        amount: BigInt(req.amountBase),
        coinId: env.coinId,
        memo: req.memo,
        transferId, // durable: a resumed run reuses it instead of double-paying
      });

      return {
        transferId: result?.transferId ?? transferId,
        status: "settled",
        deliveryPending: result?.deliveryState === "pending-delivery",
        simulated: false,
      };
    } catch (err) {
      return {
        transferId,
        status: "failed",
        deliveryPending: false,
        simulated: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }
}

export const payoutRail: PayoutRail = env.payoutMode === "sphere" ? new SphereRail() : new SimulatedRail();
