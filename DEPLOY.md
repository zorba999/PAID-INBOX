# Deploying on Vercel

The whole app is one Vercel project: the dApp is a static build, the API is a
serverless function, and the database is a Postgres store attached from the
dashboard. There is no second host.

```
api/[...path].ts   one function; all of /api reaches the same Express app
src/               the API itself
frontend/          the dApp, built to frontend/dist
vercel.json        build, rewrites, cache headers, cron
```

## Project settings

**Settings > Build and Deployment**

| Setting | Value |
|---|---|
| Framework Preset | Other |
| Root Directory | **empty** |

Root Directory must not be `frontend`. Everything above it, `api/` included,
would be invisible to the build and the API would never deploy.

`vercel.json` supplies the build command, the output directory and the install
command, so the override toggles on that page can stay off.

## Storage

**Storage > Create Database > Neon (Serverless Postgres)**, connected to this
project.

Set the integration's **Custom Prefix** to `POSTGRES`, so it writes
`POSTGRES_URL`. The app reads `POSTGRES_URL` and falls back to `DATABASE_URL`;
any other prefix produces a variable neither name matches and the server
refuses to boot.

Tick **Create database branch for deployment > Preview**. Without it a preview
deployment writes to production data, and previews are not production for
`VERCEL_ENV`, so they run with looser defaults against the real database.

## Environment variables

Production and Preview:

| Key | Value |
|---|---|
| `AUTH_SECRET` | 32 random bytes as hex |
| `ALLOW_DEMO` | `0` |
| `ESCROW_ADDRESS` | the nametag from `npm run escrow:create` |
| `ESCROW_MNEMONIC` | the mnemonic from the same command |

`POSTGRES_URL` arrives from the Neon integration.

Do **not** set `VITE_API_BASE`. The API is served from `/api` on the same
origin, so the default empty base is correct. Setting it points the build at
another host, which is the one thing that variable is for.

Do **not** import the local `.env`. It carries `ALLOW_DEMO=1`, `CORS_ORIGIN=*`
and local paths, and the first of those makes the server refuse to start in
production, deliberately.

### The startup guards

`src/env.ts` throws rather than booting when production is missing
`AUTH_SECRET`, or has `ALLOW_DEMO` on, or has no `POSTGRES_URL`. Each failure
names the variable in the deployment log. A deployment that starts has all
three.

They exist because every one of those is silent otherwise: a generated
per-boot secret invalidates sessions on each cold start, a demo signature is a
hash of a challenge and a public key so anyone can mint one for any account,
and the PGlite fallback writes to a filesystem the platform does not keep.

## Settlement without a process

A lambda cannot hold a timer, so settlement runs two ways:

- **On traffic.** Every API request may trigger a tick, throttled by
  `SETTLEMENT_MIN_INTERVAL_MS` and never awaited by the request itself.
- **On cron.** `vercel.json` calls `/api/cron/settle` once a day, which covers
  a deployment nobody is using at all.

Hobby accounts only accept a daily cron expression: anything finer is rejected
at deploy time, not ignored, so the deployment fails outright. That is why the
schedule is `0 3 * * *` and why the traffic path, not the cron, is what keeps a
live site current. On Pro, tighten it.

Both call `runSettlementTick()`, and calling it twice changes nothing:
`UNIQUE(thread_id, kind)` on the ledger is the guarantee, and settle() checks
it before paying.

Set `CRON_SECRET` to require a bearer on that endpoint. Unset, it is open,
which is fine locally and not on a public deployment.

## Local development

```bash
npm run install:all
```

```bash
npm run dev:api
```

```bash
npm run dev:web
```

No database to install: with `POSTGRES_URL` unset the API falls back to PGlite,
real Postgres compiled to WASM and persisted to `./data/pg`, running the same
SQL production runs. Vite proxies `/api` to the local API, so the dApp sees the
same same-origin shape it sees on Vercel.

## After deploying

```bash
curl -s https://<your-domain>/api/health
```

`{"ok":true,"storage":"postgres"}` means the function is live and Neon is
attached. `"storage":"pglite"` means `POSTGRES_URL` did not reach the function,
and the data will vanish with the invocation.

```bash
curl -s https://<your-domain>/api/config
```

`escrowConfigured: true` means senders have somewhere to pay. False means
`ESCROW_ADDRESS` is missing and the compose screen will say so rather than
failing at the wallet.
