/**
 * Create the platform escrow wallet.
 *
 * Run ONCE per deployment. Every sender pays into this one address; users never
 * create an escrow of their own.
 *
 *   node scripts/create-escrow-wallet.mjs [nametag]
 *
 * The generated mnemonic is written straight into server/.env and is never
 * printed: a key that lands in a terminal ends up in scrollback, in logs, and
 * in whatever transcript is recording the session.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Sphere } from "@unicitylabs/sphere-sdk";
import { createNodeProviders } from "@unicitylabs/sphere-sdk/impl/nodejs";
import { createWalletApiProviders } from "@unicitylabs/sphere-sdk/impl/shared/wallet-api";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SERVER_DIR = path.resolve(HERE, "..");
const ENV_FILE = path.join(SERVER_DIR, ".env");
const DATA_DIR = path.join(SERVER_DIR, "data", "escrow-wallet");

const NETWORK = process.env.NETWORK ?? "testnet2";
const WALLET_API = process.env.WALLET_API_URL ?? "https://wallet-api.unicity.network";
// Published in the SDK docs as a non-secret shared testnet2 key.
const API_KEY = process.env.AGGREGATOR_API_KEY ?? "sk_ddc3cfcc001e4a28ac3fad7407f99590";
const DEVICE_ID = process.env.ESCROW_DEVICE_ID ?? "paid-inbox-escrow";

const wanted = (process.argv[2] ?? "paidinbox-escrow").replace(/^@/, "").toLowerCase();

const log = (...a) => console.log(" ", ...a);

/** Merge keys into .env without clobbering anything already there. */
function writeEnv(updates) {
  let text = fs.existsSync(ENV_FILE) ? fs.readFileSync(ENV_FILE, "utf8") : "";
  if (!text && fs.existsSync(path.join(SERVER_DIR, ".env.example"))) {
    text = fs.readFileSync(path.join(SERVER_DIR, ".env.example"), "utf8");
  }
  for (const [key, value] of Object.entries(updates)) {
    const line = `${key}=${value}`;
    const re = new RegExp(`^${key}=.*$`, "m");
    text = re.test(text) ? text.replace(re, line) : `${text.trimEnd()}\n${line}\n`;
  }
  fs.writeFileSync(ENV_FILE, text.endsWith("\n") ? text : text + "\n", { mode: 0o600 });
}

console.log(`\n  Creating the escrow wallet on ${NETWORK}\n`);

if (fs.existsSync(DATA_DIR) && fs.readdirSync(DATA_DIR).length) {
  console.error(
    `  A wallet already exists in ${DATA_DIR}.\n` +
      `  Delete that directory to start over, or keep the ESCROW_MNEMONIC you already have.\n`,
  );
  process.exit(1);
}

const base = createNodeProviders({
  network: NETWORK,
  dataDir: DATA_DIR,
  oracle: { apiKey: API_KEY },
});

const providers = createWalletApiProviders(base, {
  baseUrl: WALLET_API,
  network: NETWORK,
  deviceId: DEVICE_ID,
});

// Boot once without a nametag so we can ask the network whether ours is free.
log("connecting to the network…");

let nametag = wanted;
try {
  const probe = await Sphere.init({ ...providers, network: NETWORK, autoGenerate: true });
  const sphere = probe.sphere ?? probe;

  const free = await sphere.isNametagAvailable(nametag);
  if (!free) {
    const suffix = Math.random().toString(36).slice(2, 6);
    nametag = `${wanted}-${suffix}`;
    log(`@${wanted} is taken — using @${nametag}`);
  }

  log(`registering @${nametag}…`);
  await sphere.registerNametag(nametag);

  const identity = sphere.identity ?? {};
  const mnemonic = probe.generatedMnemonic;

  if (!mnemonic) {
    console.error("\n  The SDK did not return a mnemonic. Nothing was written to .env.\n");
    process.exit(1);
  }

  writeEnv({
    ESCROW_ADDRESS: `@${nametag}`,
    ESCROW_MNEMONIC: mnemonic,
    ESCROW_DATA_DIR: "./data/escrow-wallet",
    ESCROW_DEVICE_ID: DEVICE_ID,
    WALLET_API_URL: WALLET_API,
    NETWORK,
  });

  console.log(`\n  Escrow wallet ready\n`);
  log(`nametag        @${nametag}`);
  log(`direct address ${identity.directAddress ?? "(pending)"}`);
  log(`chain pubkey   ${identity.chainPubkey ?? "(pending)"}`);
  log(`data dir       ${DATA_DIR}`);
  console.log(
    `\n  ESCROW_ADDRESS and ESCROW_MNEMONIC were written to server/.env (gitignored).` +
      `\n  The mnemonic is deliberately not printed here. Back up that file — it is the` +
      `\n  only way to reach the float.\n`,
  );

  process.exit(0);
} catch (err) {
  console.error(`\n  Failed: ${err instanceof Error ? err.message : err}\n`);
  console.error(
    "  If this is a network or gateway error, the CLI is the documented fallback:\n" +
      "    npm i -g @unicity-sphere/cli\n" +
      "    sphere wallet create escrow\n" +
      `    sphere init --network testnet --nametag ${wanted}\n` +
      "  then copy the nametag into ESCROW_ADDRESS and the mnemonic into ESCROW_MNEMONIC.\n",
  );
  process.exit(1);
}
