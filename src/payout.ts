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
 *   sphere    — a real escrow wallet on testnet2 settles with payments.send().
 *               Requires ESCROW_MNEMONIC + WALLET_API_URL.
 *
 * Idempotency: the ledger's UNIQUE(thread_id, kind) is the hard guarantee, and
 * settle() checks it before calling in. The SDK's `send` takes no caller-supplied
 * transfer id, so a crash between the broadcast and the ledger write is the one
 * window that needs an operator to reconcile — `settlement_failed` events and
 * /api/reconciliation exist for exactly that.
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
  /** Escrow float, base units. `null` when the rail cannot report one. */
  balance(): Promise<string | null>;
  /** The address senders should pay into. `null` for the simulated rail. */
  address(): Promise<string | null>;
  send(req: PayoutRequest): Promise<PayoutResult>;
}

/** Stable per (thread, kind) — used to label our own ledger row. */
function localTransferId(threadId: string, kind: string): string {
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

  async address(): Promise<string | null> {
    return null;
  }

  async send(req: PayoutRequest): Promise<PayoutResult> {
    return {
      transferId: `sim-${localTransferId(req.threadId, req.kind)}`,
      status: "settled",
      deliveryPending: false,
      simulated: true,
    };
  }
}

/* ---------------------------------------------------------------- sphere
 *
 * On serverless the escrow wallet re-derives from the mnemonic on every cold
 * start and its dataDir cache does not survive, so the first settlement after
 * an idle period pays a boot cost. Correctness is unaffected: the keys come
 * from ESCROW_MNEMONIC and custody lives in wallet-api, not on disk.
 * -------------------------------------------------------------------- */

class SphereRail implements PayoutRail {
  readonly mode = "sphere" as const;
  private sphere: any = null;
  private booting: Promise<void> | null = null;

  private async boot(): Promise<void> {
    if (this.sphere) return;
    if (this.booting) return this.booting;

    this.booting = (async () => {
      // Since sphere-sdk 0.14 there is no own-storage custody: Sphere.init
      // throws INVALID_CONFIG without a wallet-api composition.
      if (!env.walletApiUrl) throw new Error("WALLET_API_URL is required for PAYOUT_MODE=sphere");

      const { Sphere } = (await import("@unicitylabs/sphere-sdk")) as any;
      const { createNodeProviders } = (await import("@unicitylabs/sphere-sdk/impl/nodejs")) as any;
      const { createWalletApiProviders } = (await import(
        "@unicitylabs/sphere-sdk/impl/shared/wallet-api"
      )) as any;

      // 1. base providers: storage, transport, oracle
      const base = createNodeProviders({
        network: env.network,
        dataDir: env.escrowDataDir,
        ...(env.aggregatorApiKey ? { oracle: { apiKey: env.aggregatorApiKey } } : {}),
      });

      // 2. the money rail — token custody and the mailbox live here
      const providers = createWalletApiProviders(base, {
        baseUrl: env.walletApiUrl,
        network: env.network,
        deviceId: env.escrowDeviceId,
      });

      // 3. the wallet itself. autoGenerate only fires when no mnemonic is set
      //    AND no wallet exists in dataDir yet.
      const result = await Sphere.init({
        ...providers,
        network: env.network,
        ...(env.escrowMnemonic ? { mnemonic: env.escrowMnemonic } : { autoGenerate: true }),
      });

      this.sphere = result.sphere ?? result;

      if (result.created && result.generatedMnemonic) {
        console.warn(
          "\n[escrow] A NEW escrow wallet was generated. Save this mnemonic into ESCROW_MNEMONIC" +
            " or the float becomes unreachable on the next boot:\n\n  " +
            result.generatedMnemonic +
            "\n",
        );
      }

      const addr = this.sphere?.identity?.nametag ?? this.sphere?.identity?.directAddress;
      console.log(`[escrow] wallet ready on ${env.network}: ${addr ?? "(no identity)"}`);
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
    } catch (err) {
      console.error("[escrow] boot failed:", err instanceof Error ? err.message : err);
      return false;
    }
  }

  async address(): Promise<string | null> {
    try {
      await this.boot();
      return this.sphere?.identity?.nametag ?? this.sphere?.identity?.directAddress ?? null;
    } catch {
      return null;
    }
  }

  async balance(): Promise<string | null> {
    try {
      await this.boot();
      // Reads the wallet-api inventory, which the server credits asynchronously —
      // a just-settled transfer can be missing here until `inventory:updated`.
      const assets = await this.sphere.payments.assets();
      const match = (assets as Array<{ coinId?: string; amount?: string }>).find(
        (a) => a.coinId?.toLowerCase() === env.coinId,
      );
      return match?.amount ?? "0";
    } catch {
      return null;
    }
  }

  async send(req: PayoutRequest): Promise<PayoutResult> {
    const fallbackId = localTransferId(req.threadId, req.kind);
    try {
      await this.boot();

      const result = await this.sphere.payments.send({
        recipient: req.toAddress ?? req.toPubkey,
        amount: req.amountBase, // base units, as a string — same convention as the wire
        coinId: env.coinId,
      });

      if (result?.error) {
        return { transferId: fallbackId, status: "failed", deliveryPending: false, simulated: false, error: String(result.error) };
      }

      return {
        transferId: result?.transferId ?? fallbackId,
        status: "settled",
        // The SDK reports recipient-side delivery separately from on-chain finality.
        deliveryPending: result?.deliveryState === "pending-delivery",
        simulated: false,
      };
    } catch (err) {
      return {
        transferId: fallbackId,
        status: "failed",
        deliveryPending: false,
        simulated: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }
}

export const payoutRail: PayoutRail = env.payoutMode === "sphere" ? new SphereRail() : new SimulatedRail();
