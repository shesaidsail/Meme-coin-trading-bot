# Solana memecoin trading bot

A modular TypeScript bot that scans Solana memecoins in a target market-cap band, rejects likely rugs with on-chain and API checks, and manages positions with a net take-profit, a 48h time stop and an optional stop-loss.

It runs in **paper mode by default**: paper fills are simulated against real Jupiter quotes. Live trading requires `mode: live` in the config plus a wallet key in `.env`, and it is not implemented yet.

> Memecoin trading is extremely high risk. The filters reduce rug exposure but cannot eliminate it. Run paper mode long enough to trust the numbers before going live.

## Status

| Step | Scope | State |
|---|---|---|
| 1 | Scaffolding, config, SQLite storage, logging | ✅ done |
| 2 | API clients (rate limits + daily budgets), scanner, rug filters | ✅ done |
| 3 | Risk math (equity, sizing, caps, exit multiplier), paper executor | ⏳ next |
| 4 | Monitor, engine loop, kill switch, CLI summary (paper mode end to end) | — |
| 5 | Live executor (only after paper mode is verified) | — |

## Requirements

- Node.js 22.12 or newer (`.nvmrc`). Node 20 is end-of-life, and current releases of `better-sqlite3`, `commander` and `vitest` require 22.

## Setup

```bash
npm install
cp .env.example .env        # fill in SOLANA_RPC_URL; other keys are optional
npm run bot -- config       # validate config/config.yaml and show which secrets are present
npm run bot -- init         # create data/bot.db and seed the paper balance (10 SOL by default)
npm test

npm run bot -- scan                # one discovery scan + filter pipeline (records results, never trades)
npm run bot -- scan --all-filters  # run every filter on every candidate (fuller stats, more API calls)
npm run bot -- filters             # per-filter outcomes: pass / fail / no data / warn / skipped
npm run bot -- api-usage           # today's usage vs. budgets + latest rate-limit headers per provider
npm run bot -- evaluate <mint...>  # full filter pipeline on given tokens, with each decision's data source
npm run bot -- collect             # pool listener + periodic scans + filtering; never trades (for stats)
npm run bot -- sources --hours 24  # discovery yield per source (candidates/hour)
```

## Data sources

Everything works on free tiers: public Solana RPC or free Helius, DexScreener, RugCheck and Jupiter `lite-api`. Birdeye is added automatically when `BIRDEYE_API_KEY` is set.

| Provider | Used for | Notes from live testing |
|---|---|---|
| DexScreener | discovery (profiles, boosts, takeovers, ads); price, market cap, liquidity, pools (30 mints per call) | no rate-limit headers |
| RugCheck | discovery (new / recent / trending); score, risks, LP lock %, holders, creator, insider networks | `x-rate-limit-limit: 15` (window ~1s); `/stats/trending` can return `null` |
| Solana RPC | mint/freeze authority, Token-2022 extensions, LP supply, largest holders, launch history | public RPC blocks `getTokenLargestAccounts` (`x-ratelimit-method-limit: 0`); holders then come from RugCheck |
| Jupiter | honeypot buy→sell quotes; later, execution | `priceImpactPct` is a fraction, not a percent |
| Birdeye (optional) | discovery by market-cap band | response shape follows docs, unverified without a key |

**Real-time pool creations (RPC WebSocket).** `collect`, and later `run`, subscribe to accounts that appear only in pool-creation transactions:
- the pump.fun migration authority, for graduations to PumpSwap;
- Raydium's CPMM pool-creation fee receiver, which also covers Raydium LaunchLab graduations.

Subscribing to the AMM programs themselves would stream every swap (about 500 events a second for PumpSwap), so these narrower subscriptions keep volume low.

Each creation is resolved with one `getTransaction` (1 Helius credit). The new token goes on the watchlist with `eligible_at` = pool creation + `tokenAge.minAgeMinutes`, and it is not priced before then. The listener reconnects with backoff, reconnects when the socket goes quiet, and after each reconnect backfills signatures it missed.

Raydium AMM v4 is not subscribed: it creates almost no new pools any more.

`bot sources` shows, per source:
- how many mints it reported;
- how many it reported first;
- how many became filter candidates, and how many passed, per hour.

The scanner adds every discovered mint to a persistent watchlist. Each scan re-prices due entries and passes the in-band ones, closest to the target market cap first, through the filters. Young tokens wait on the watchlist until they are old enough.

## Rug filters

The filters run cheapest-first, so most tokens are rejected before the expensive calls. Each filter records its outcome and reason, plus the data source (`onchain` / `rugcheck` / `jupiter`).

| Filter | Primary source | Fallback |
|---|---|---|
| liquidity, liquidity/mcap | DexScreener (primary pool) | — |
| tokenAge | earliest pair creation | RugCheck first-detected time |
| mintAuthority, freezeAuthority, token2022 | on-chain mint account | RugCheck |
| rugcheckScore | RugCheck normalised **risk** score (higher = riskier), rugged flag, danger risks | — |
| lpLocked | on-chain LP supply = 0 (burned) for the primary pool | RugCheck locked % (position-based pools fail unless locked) |
| holderCount | RugCheck | — |
| holderConcentration | on-chain top accounts by owner, excluding pools/burn | RugCheck top holders |
| bundledLaunch | on-chain launch-slot buys (bounded history walk) | RugCheck insider-held % and linked-network size |
| devWallet | RugCheck creator balance; on-chain launch buy → sold % when known | — |
| honeypot | Jupiter buy quote at entry size → sell quote of the result | — |

## Configuration

- **`config/config.yaml`** holds every tunable, with comments. It lists the built-in defaults, and a test keeps the file and the schema in sync.
- **`.env`** holds secrets only: RPC URL, API keys and the wallet key. It is gitignored.
  - The wallet key is read only in live mode.
  - Secrets are wrapped so they cannot reach logs, JSON or `console.log`.
  - Log lines and audit data are also scrubbed for `?api-key=` URLs, bearer tokens and base58 secret keys.
- **Missing data:** each filter has an `onMissingData` setting:
  - `reject` (the default): the token fails, and the rejection is counted as `insufficient_data`, separately from real failures.
  - `skip`: the filter is ignored for that token.
  - `warn`: the token passes, and the gap is logged.
- **API limits:** each provider has a rate limit and a daily budget. Usage is stored in SQLite, so restarts don't reset it. Part of each budget (`reserveFraction`) is held back for exit quotes and sells, so scanning pauses before the bot loses the ability to exit.

## Storage

The bot uses SQLite in WAL mode with `synchronous=FULL`, at `storage.path`.

- **Atomic writes.** Opening a position writes the trade, the position, the cash debit and an audit entry in one transaction. Each sell attempt (filled, partial or failed) is also a single transaction.
- **Timestamps, not timers.** The entry time and the 48h deadline are stored as absolute timestamps. After a restart the bot picks up exactly where it left off. A deadline that passed while the bot was down is due immediately.
- **One mode per database.** A database is stamped with its mode, and opening a paper DB in live mode, or the reverse, is refused.
- **Exact amounts.** Lamport and token amounts are stored as integer strings and handled as `bigint`.

Tables: `positions`, `trades` (every attempt), `cash_ledger` (running balance), `audit_log`, `evaluations` and `filter_results` (per-filter outcome for each candidate), `watchlist`, `api_usage`, `api_rate_observations` (rate-limit headers as returned, sampled, plus every 429), `equity_snapshots`.

## Layout

```
config/config.yaml   all settings
src/config/          zod schema + loader (YAML + .env)
src/storage/         migrations, repositories, transactional Storage facade
src/clients/         HTTP layer (rate limiter, daily budgets, retries, header capture) + per-API clients
src/scanner/         discovery → watchlist → pricing → market-cap band
src/filters/         one module per rug check, shared per-token context, pipeline
src/engine/          evaluation runner (scanner → filters → storage)
src/cli/             report formatting
src/util/            logger (pino, redacting), secrets, clock, bigint units
test/fixtures/       real API responses captured from the live endpoints
test/                vitest unit tests (+ helpers: fake fetch, filter context)
```
