# Paid Inbox

**Attention has a price.** Pay to reach someone's inbox; they earn it by replying. Stay unanswered and
every unit goes back to the sender. Built on **Unicity**, connected with a **Sphere wallet** over the
Sphere Connect protocol.

```
frontend/   Vite + React + TypeScript   — the dApp (wallet adapter lives here)
server/     Node + Express + node:sqlite — auth, escrow state machine, settlement worker
```

---

## Run it

```bash
npm run install:all
```

Two terminals:

```bash
npm run dev:server
```

```bash
npm run dev:web
```

Then open **http://localhost:5174**. Click **Try demo wallet** — the whole product works with no wallet
installed (see [Demo mode](#demo-mode)).

Copy `server/.env.example` → `server/.env` and `frontend/.env.example` → `frontend/.env` to change
anything.

---

## The wallet adapter

`frontend/src/wallet/WalletProvider.tsx` is the piece worth reading. It owns the entire Sphere Connect
lifecycle and encodes the rules the protocol reference is emphatic about:

| Rule | Where |
|---|---|
| Transport priority **iframe → extension → popup** | `autoConnect` from `@unicitylabs/sphere-sdk/connect/browser` |
| Silent auto-connect on mount, with `isAutoConnecting` so the Connect button never flashes | `runConnect(true)` |
| `wallet:locked` **preserves the session** on Connect 2.1 — do not tear down, do not re-handshake | `wireLifecycle` |
| A 2.0 wallet means the opposite, so feature-detect on `walletProtocol` | `supportsGracefulLock()` |
| Stop issuing reads while locked; resume on `unlockEpoch` | every read effect |
| **Never auto-replay an intent** after unlock | no retry queue, by design |
| **4201 `INTENT_OUTCOME_UNKNOWN` is never retried** | `classifyRequestError` → `outcome-unknown` |
| Raise the wallet only for a *user-driven* refusal, sampled from `navigator.userActivation` before any await | `intent()` |
| Discriminate on numeric `.code`, never on message text | `lib/connectErrors.ts` |

**Scopes requested** (10 of the 13; we ask for what the product uses and nothing else):
`identity:read` · `sign:request` · `transfer:request` · `dm:request` · `dm:read` · `dm:manage` ·
`resolve:peer` · `events:subscribe` · `balance:read` · `history:read`

**Network** testnet2 (`id: 4`) · **Coin** UCT `f581d30f…c24dc0`, 18 decimals.

---

## How a paid message works

```
 SENDER                          ESCROW (bot wallet)              RECIPIENT
   │                                    │                              │
   │ 1. POST /api/threads               │                              │
   │──────────────────────────────────► │  thread = PAYING             │
   │                                    │                              │
   │ 2. intent('send', {memo: ref})     │                              │
   │═══════════════════════════════════►│  thread = ESCROWED           │
   │                                    │                              │
   │ 3. intent('dm')  ───────── encrypted, wallet to wallet ──────────►│
   │                                    │  thread = DELIVERED          │
   │                                    │  deadline starts here        │
   │                                    │                              │
   │                                    │   4. intent('dm')  reply     │
   │                                    │   5. intent('sign_message')  │
   │                                    │◄─────────────────────────────│
   │                                    │  thread = REPLIED            │
   │                                    │                              │
   │        ◄── dispute window (24h) ── │ ── settlement worker ───────►│
   │             REFUNDED               │              RELEASED − fee  │
```

Two intents on the send, on purpose. The payment and the message are separate acts, and keeping them
apart is what lets the message stay end-to-end encrypted: **the server never sees a message body**, only
an id and a SHA-256 hash.

### How a reply is proven without reading it

The backend cannot read a NIP-17 DM, so it does not try. The recipient replies through the dApp, gets a
`messageId` back from the `dm` intent, and then signs a server-issued challenge binding
`{threadId, ref, messageId, timestamp, nonce}`. The server recovers the pubkey from the signature with
`verifySignedMessage` and checks it is the recipient's. Nobody has to be trusted with the plaintext.

The sender gets a **dispute window** before the payout fires.

---

## The escrow is custodial — and says so

Unicity has no smart contracts, so an escrow has to be a wallet somebody runs. The app does not hide
this:

- `/ledger` publishes the invariant **float ≥ open escrow + fees**, recomputed on load.
- Every state transition is written to an append-only `thread_events` table.
- Settlement is idempotent twice over: `UNIQUE(thread_id, kind)` on the ledger, and a **durable transfer
  id derived from `sha256(threadId:kind)`** so a crashed run resumes onto the same intent instead of
  paying twice.
- Every amount is a **string in base units**, summed in `BigInt`. `SUM()` in SQL on an 18-decimals value
  returns a float and silently loses the low digits — there is not a single SQL aggregate over an amount
  in this codebase.

### Payout rails

| `PAYOUT_MODE` | What happens |
|---|---|
| `simulated` (default) | State machine, ledger and reconciliation are real. The transfer is journalled, not broadcast. No keys needed. |
| `sphere` | A real bot wallet settles on testnet2 via `payments.send`. Needs `BOT_MNEMONIC` **and** `WALLET_API_URL` — since sphere-sdk 0.14 there is no own-storage custody and `Sphere.init` throws `INVALID_CONFIG` without a wallet-api composition. |

---

## Demo mode

`frontend/src/wallet/demoHost.ts` is a simulated wallet that speaks the **real Sphere Connect wire
protocol** over an in-memory transport. The dApp code path is byte-for-byte identical to production —
same `ConnectClient`, same handshake, same queries, intents, events and error codes. Only the far side
of the transport is simulated, and it is labelled everywhere in the UI.

It has a working approval sheet (so intents still need a human), a **Lock / Unlock** control that
exercises the session-preserving lock path, and a self-mint button.

**No real money moves in demo mode.** Server-side, demo signatures are accepted only when `ALLOW_DEMO=1`,
and `env.ts` refuses to boot in production with that flag on.

---

## Design

Unicity's palette — orange `#FF6F00`, ink `#060606`, paper `#FEFEFE` — with Anton for display, Inter for
text and Geist Mono for the bracketed micro-labels. Editorial layout, hairline rules, pill controls.

Dark and light are both first-class: the theme is written to `data-theme` on `<html>` **before first
paint** by an inline script in `index.html`, so a reload never flashes the wrong one. With no stored
choice the OS preference wins.

---

## Testing against a real wallet

Local wallet on `:5173`, dApp on `:5174`.

Against the hosted wallet, **iframe is the only path that works** — load the dApp as a custom agent at
`https://sphere.unicity.network/agents/custom`. The popup path returns **403** against the hosted wallet.

To list the app in the Sphere desktop, open a PR against
[`unicity-sphere/sphere-apps`](https://github.com/unicity-sphere/sphere-apps) adding an entry to
`apps.json`.

---

## Before production

- [ ] `AUTH_SECRET` set, `ALLOW_DEMO=0` (both are enforced — the server refuses to boot otherwise)
- [ ] `PAYOUT_MODE=sphere` with a funded bot wallet, and reconciliation alerting on a shortfall
- [ ] Postgres instead of SQLite, with backups on the escrow ledger
- [ ] Rate limits per pubkey, and a real arbitration path for `DISPUTED`
