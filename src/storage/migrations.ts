import type Database from 'better-sqlite3';

/**
 * Ordered, append-only list of schema migrations. Never edit a migration
 * that has shipped; add a new one instead.
 *
 * Conventions:
 * - Timestamps are INTEGER milliseconds since epoch (UTC).
 * - Lamport and raw token amounts are TEXT decimal strings (u64 token
 *   amounts can exceed SQLite's signed 64-bit INTEGER), converted to bigint
 *   in the repositories.
 */
export const MIGRATIONS: { version: number; name: string; sql: string }[] = [
  {
    version: 1,
    name: 'init',
    sql: `
      CREATE TABLE kv (
        key   TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );

      CREATE TABLE positions (
        id                          INTEGER PRIMARY KEY AUTOINCREMENT,
        mint                        TEXT    NOT NULL,
        symbol                      TEXT,
        mode                        TEXT    NOT NULL CHECK (mode IN ('paper','live')),
        status                      TEXT    NOT NULL CHECK (status IN ('open','closed')),
        token_decimals              INTEGER NOT NULL,
        initial_token_amount_raw    TEXT    NOT NULL,
        token_amount_raw            TEXT    NOT NULL,
        cost_basis_lamports         TEXT    NOT NULL,
        entry_sol_usd               REAL,
        entry_mcap_usd              REAL,
        buy_cost_fraction           REAL    NOT NULL,
        sell_cost_fraction          REAL    NOT NULL,
        tp_gross_multiplier         REAL    NOT NULL,
        tp_target_net_lamports      TEXT    NOT NULL,
        entered_at                  INTEGER NOT NULL,
        time_stop_at                INTEGER NOT NULL,
        stop_loss_fraction          REAL,
        shadow_sl_triggered_at      INTEGER,
        shadow_sl_value_lamports    TEXT,
        last_quote_lamports         TEXT,
        last_quote_at               INTEGER,
        peak_quote_lamports         TEXT,
        consecutive_quote_failures  INTEGER NOT NULL DEFAULT 0,
        unquotable_since            INTEGER,
        realized_lamports           TEXT    NOT NULL DEFAULT '0',
        exit_reason                 TEXT CHECK (exit_reason IN
                                      ('take_profit','time_stop','stop_loss','manual')),
        exited_at                   INTEGER,
        exit_sol_usd                REAL
      );
      -- At most one open position per mint.
      CREATE UNIQUE INDEX ux_positions_open_mint ON positions(mint) WHERE status = 'open';
      CREATE INDEX ix_positions_status ON positions(status, time_stop_at);

      -- Every buy/sell attempt, including failures and partial fills.
      CREATE TABLE trades (
        id                 INTEGER PRIMARY KEY AUTOINCREMENT,
        position_id        INTEGER REFERENCES positions(id),
        mint               TEXT    NOT NULL,
        side               TEXT    NOT NULL CHECK (side IN ('buy','sell')),
        mode               TEXT    NOT NULL CHECK (mode IN ('paper','live')),
        status             TEXT    NOT NULL CHECK (status IN ('filled','partial','failed')),
        reason             TEXT,
        attempt            INTEGER NOT NULL DEFAULT 1,
        slippage_bps       INTEGER,
        in_amount_raw      TEXT    NOT NULL,
        in_filled_raw      TEXT    NOT NULL DEFAULT '0',
        out_amount_raw     TEXT    NOT NULL DEFAULT '0',
        quoted_out_raw     TEXT,
        price_impact       REAL,
        fee_lamports       TEXT    NOT NULL DEFAULT '0',
        sol_usd            REAL,
        signature          TEXT,
        error              TEXT,
        created_at         INTEGER NOT NULL
      );
      CREATE INDEX ix_trades_position ON trades(position_id);

      -- Running SOL cash balance. balance_lamports is the balance after this row.
      CREATE TABLE cash_ledger (
        id                INTEGER PRIMARY KEY AUTOINCREMENT,
        ts                INTEGER NOT NULL,
        kind              TEXT    NOT NULL CHECK (kind IN ('initial','buy','sell','adjustment')),
        delta_lamports    TEXT    NOT NULL,
        balance_lamports  TEXT    NOT NULL,
        position_id       INTEGER REFERENCES positions(id),
        trade_id          INTEGER REFERENCES trades(id),
        note              TEXT
      );

      CREATE TABLE audit_log (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        ts           INTEGER NOT NULL,
        level        TEXT    NOT NULL CHECK (level IN ('info','warn','error')),
        event        TEXT    NOT NULL,
        mint         TEXT,
        position_id  INTEGER,
        data         TEXT
      );
      CREATE INDEX ix_audit_ts ON audit_log(ts);
      CREATE INDEX ix_audit_event ON audit_log(event);

      -- One row per candidate token evaluated by the filter pipeline.
      CREATE TABLE evaluations (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        ts           INTEGER NOT NULL,
        scan_id      TEXT    NOT NULL,
        mint         TEXT    NOT NULL,
        symbol       TEXT,
        mcap_usd     REAL,
        liquidity_usd REAL,
        verdict      TEXT    NOT NULL CHECK (verdict IN ('passed','rejected')),
        rejected_by  TEXT,
        decision     TEXT
      );
      CREATE INDEX ix_evaluations_mint ON evaluations(mint, ts);

      -- One row per (evaluation, filter).
      CREATE TABLE filter_results (
        id             INTEGER PRIMARY KEY AUTOINCREMENT,
        evaluation_id  INTEGER NOT NULL REFERENCES evaluations(id),
        ts             INTEGER NOT NULL,
        mint           TEXT    NOT NULL,
        filter         TEXT    NOT NULL,
        outcome        TEXT    NOT NULL CHECK (outcome IN
                         ('pass','fail','insufficient_data','skipped','warn')),
        reason         TEXT,
        data           TEXT
      );
      CREATE INDEX ix_filter_results_filter ON filter_results(filter, outcome);

      -- Per-provider daily API usage, for rate budgets that survive restarts.
      CREATE TABLE api_usage (
        provider   TEXT    NOT NULL,
        day        TEXT    NOT NULL,
        units      INTEGER NOT NULL DEFAULT 0,
        calls      INTEGER NOT NULL DEFAULT 0,
        throttled  INTEGER NOT NULL DEFAULT 0,
        errors     INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (provider, day)
      );

      CREATE TABLE equity_snapshots (
        id                   INTEGER PRIMARY KEY AUTOINCREMENT,
        ts                   INTEGER NOT NULL,
        cash_lamports        TEXT    NOT NULL,
        positions_lamports   TEXT    NOT NULL,
        equity_lamports      TEXT    NOT NULL,
        sol_usd              REAL,
        open_positions       INTEGER NOT NULL,
        unquotable_positions INTEGER NOT NULL
      );
      CREATE INDEX ix_equity_ts ON equity_snapshots(ts);
    `,
  },
  {
    version: 2,
    name: 'scanner_watchlist_and_rate_observations',
    sql: `
      -- Mints discovered by any source. Young tokens wait here until they are
      -- old enough to evaluate; evaluated tokens are rechecked after a cooldown.
      CREATE TABLE watchlist (
        mint             TEXT    PRIMARY KEY,
        source           TEXT    NOT NULL,
        first_seen_at    INTEGER NOT NULL,
        last_seen_at     INTEGER NOT NULL,
        last_checked_at  INTEGER,
        checks           INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX ix_watchlist_due ON watchlist(last_checked_at, first_seen_at);

      -- Rate-limit related response headers as actually returned by each
      -- provider, sampled, plus every 429. Used to tune budgets from real data.
      CREATE TABLE api_rate_observations (
        id        INTEGER PRIMARY KEY AUTOINCREMENT,
        ts        INTEGER NOT NULL,
        provider  TEXT    NOT NULL,
        endpoint  TEXT    NOT NULL,
        status    INTEGER NOT NULL,
        headers   TEXT    NOT NULL
      );
      CREATE INDEX ix_rate_obs_provider ON api_rate_observations(provider, ts);
    `,
  },
];

export function migrate(db: Database.Database, now: number): number[] {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version    INTEGER PRIMARY KEY,
    name       TEXT    NOT NULL,
    applied_at INTEGER NOT NULL
  )`);
  const applied = new Set(
    (db.prepare('SELECT version FROM schema_migrations').all() as { version: number }[]).map(
      (r) => r.version,
    ),
  );
  const ran: number[] = [];
  const record = db.prepare(
    'INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)',
  );
  for (const m of MIGRATIONS) {
    if (applied.has(m.version)) continue;
    db.transaction(() => {
      db.exec(m.sql);
      record.run(m.version, m.name, now);
    })();
    ran.push(m.version);
  }
  return ran;
}
