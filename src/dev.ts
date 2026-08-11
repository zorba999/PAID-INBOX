import { createApp, resolveEscrowAddress } from "./app.js";
import { initDb } from "./db.js";
import { env } from "./env.js";
import { payoutRail } from "./payout.js";
import { runSettlementTick } from "./settlement.js";

/* ==========================================================================
 * Local development server.
 *
 * The same Express app Vercel serves, plus the two things a long-lived process
 * can do that a lambda cannot: warm the database up front, and run settlement
 * on a real timer instead of on request traffic.
 * ======================================================================== */

const app = createApp();

await initDb();
const escrow = await resolveEscrowAddress();

app.listen(env.port, () => {
  console.log(`\n  Paid Inbox API   http://localhost:${env.port}`);
  console.log(`  storage          ${env.postgresUrl ? "postgres" : `pglite (${env.localDataDir})`}`);
  console.log(`  payout rail      ${payoutRail.mode}${payoutRail.mode === "simulated" ? "  (no on-chain transfer)" : ""}`);
  console.log(`  payout policy    ${env.payoutPolicy}`);
  console.log(`  fee              ${env.feeBps / 100}%`);
  console.log(`  demo signatures  ${env.allowDemo ? "allowed" : "refused"}`);
  console.log(`  escrow address   ${escrow ?? "NOT SET, senders cannot pay"}`);
  console.log(`  network          ${env.network}\n`);
});

const tick = () => {
  runSettlementTick().catch((err) => console.error("[settlement] tick failed:", err));
};
tick();
setInterval(tick, 15_000);
