# Solana memecoin trading bot

A modular TypeScript bot that scans Solana memecoins in a target market-cap band, rejects likely rugs with on-chain and API checks, and manages positions with a net take-profit, a 48h time stop and an optional stop-loss.

It runs in **paper mode by default**: paper fills are simulated against real Jupiter quotes. Live trading requires `mode: live` in the config plus a wallet key in `.env`, and it is not implemented yet.

> Memecoin trading is extremely high risk. The filters reduce rug exposure but cannot eliminate it. Run paper mode long enough to trust the numbers before going live.

## Status

| Step | Scope | State |
|---|---|---|
| 1 | Scaffolding, config, SQLite storage, logging | ✅ done |
| 2 | API clients (rate limits + daily budgets), scanner, rug filters | ⏳ next |
| 3 | Risk math (equity, sizing, caps, exit multiplier), paper executor | — |
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
```

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

Tables: `positions`, `trades` (every attempt), `cash_ledger` (running balance), `audit_log`, `evaluations` and `filter_results` (per-filter outcome for each candidate), `api_usage`, `equity_snapshots`.

## Layout

```
config/config.yaml   all settings
src/config/          zod schema + loader (YAML + .env)
src/storage/         migrations, repositories, transactional Storage facade
src/util/            logger (pino, redacting), secrets, clock, bigint units
test/                vitest unit tests (+ helpers)
```
