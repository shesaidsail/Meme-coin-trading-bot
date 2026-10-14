import type Database from 'better-sqlite3';
import type { ExitReason, NewPosition, Position } from './types.js';

interface Row {
  id: number;
  mint: string;
  symbol: string | null;
  mode: Position['mode'];
  status: Position['status'];
  token_decimals: number;
  initial_token_amount_raw: string;
  token_amount_raw: string;
  cost_basis_lamports: string;
  entry_sol_usd: number | null;
  entry_mcap_usd: number | null;
  buy_cost_fraction: number;
  sell_cost_fraction: number;
  tp_gross_multiplier: number;
  tp_target_net_lamports: string;
  entered_at: number;
  time_stop_at: number;
  stop_loss_fraction: number | null;
  shadow_sl_triggered_at: number | null;
  shadow_sl_value_lamports: string | null;
  last_quote_lamports: string | null;
  last_quote_at: number | null;
  peak_quote_lamports: string | null;
  consecutive_quote_failures: number;
  unquotable_since: number | null;
  realized_lamports: string;
  exit_reason: ExitReason | null;
  exited_at: number | null;
  exit_sol_usd: number | null;
}

const big = (s: string | null): bigint | null => (s === null ? null : BigInt(s));

function fromRow(r: Row): Position {
  return {
    id: r.id,
    mint: r.mint,
    symbol: r.symbol,
    mode: r.mode,
    status: r.status,
    tokenDecimals: r.token_decimals,
    initialTokenAmountRaw: BigInt(r.initial_token_amount_raw),
    tokenAmountRaw: BigInt(r.token_amount_raw),
    costBasisLamports: BigInt(r.cost_basis_lamports),
    entrySolUsd: r.entry_sol_usd,
    entryMcapUsd: r.entry_mcap_usd,
    buyCostFraction: r.buy_cost_fraction,
    sellCostFraction: r.sell_cost_fraction,
    tpGrossMultiplier: r.tp_gross_multiplier,
    tpTargetNetLamports: BigInt(r.tp_target_net_lamports),
    enteredAt: r.entered_at,
    timeStopAt: r.time_stop_at,
    stopLossFraction: r.stop_loss_fraction,
    shadowSlTriggeredAt: r.shadow_sl_triggered_at,
    shadowSlValueLamports: big(r.shadow_sl_value_lamports),
    lastQuoteLamports: big(r.last_quote_lamports),
    lastQuoteAt: r.last_quote_at,
    peakQuoteLamports: big(r.peak_quote_lamports),
    consecutiveQuoteFailures: r.consecutive_quote_failures,
    unquotableSince: r.unquotable_since,
    realizedLamports: BigInt(r.realized_lamports),
    exitReason: r.exit_reason,
    exitedAt: r.exited_at,
    exitSolUsd: r.exit_sol_usd,
  };
}

export class PositionsRepo {
  constructor(private readonly db: Database.Database) {}

  insert(p: NewPosition): number {
    if (p.tokenAmountRaw <= 0n) throw new RangeError('position token amount must be positive');
    if (p.timeStopAt <= p.enteredAt) throw new RangeError('time_stop_at must be after entered_at');
    const res = this.db
      .prepare(
        `INSERT INTO positions (
          mint, symbol, mode, status, token_decimals, initial_token_amount_raw, token_amount_raw,
          cost_basis_lamports, entry_sol_usd, entry_mcap_usd, buy_cost_fraction, sell_cost_fraction,
          tp_gross_multiplier, tp_target_net_lamports, entered_at, time_stop_at, stop_loss_fraction
        ) VALUES (?, ?, ?, 'open', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        p.mint,
        p.symbol,
        p.mode,
        p.tokenDecimals,
        p.tokenAmountRaw.toString(),
        p.tokenAmountRaw.toString(),
        p.costBasisLamports.toString(),
        p.entrySolUsd,
        p.entryMcapUsd,
        p.buyCostFraction,
        p.sellCostFraction,
        p.tpGrossMultiplier,
        p.tpTargetNetLamports.toString(),
        p.enteredAt,
        p.timeStopAt,
        p.stopLossFraction,
      );
    return Number(res.lastInsertRowid);
  }

  get(id: number): Position | null {
    const r = this.db.prepare('SELECT * FROM positions WHERE id = ?').get(id) as Row | undefined;
    return r ? fromRow(r) : null;
  }

  getOpenByMint(mint: string): Position | null {
    const r = this.db
      .prepare(`SELECT * FROM positions WHERE mint = ? AND status = 'open'`)
      .get(mint) as Row | undefined;
    return r ? fromRow(r) : null;
  }

  listOpen(): Position[] {
    return (
      this.db
        .prepare(`SELECT * FROM positions WHERE status = 'open' ORDER BY entered_at`)
        .all() as Row[]
    ).map(fromRow);
  }

  listClosed(): Position[] {
    return (
      this.db
        .prepare(`SELECT * FROM positions WHERE status = 'closed' ORDER BY exited_at`)
        .all() as Row[]
    ).map(fromRow);
  }

  countOpen(): number {
    return (
      this.db.prepare(`SELECT COUNT(*) AS n FROM positions WHERE status = 'open'`).get() as {
        n: number;
      }
    ).n;
  }

  /** Open positions whose 48h (configurable) time stop has elapsed at `now`. */
  listTimeStopDue(now: number): Position[] {
    return (
      this.db
        .prepare(
          `SELECT * FROM positions WHERE status = 'open' AND time_stop_at <= ? ORDER BY time_stop_at`,
        )
        .all(now) as Row[]
    ).map(fromRow);
  }

  /** Has this mint ever been traded? Used to avoid re-entering the same token. */
  hasEverHeld(mint: string): boolean {
    return !!this.db.prepare('SELECT 1 FROM positions WHERE mint = ? LIMIT 1').get(mint);
  }

  /** Successful sell quote: resets the failure streak and clears the unquotable flag. */
  recordQuote(id: number, valueLamports: bigint, at: number): void {
    const p = this.mustGet(id);
    const peak =
      p.peakQuoteLamports === null || valueLamports > p.peakQuoteLamports
        ? valueLamports
        : p.peakQuoteLamports;
    this.db
      .prepare(
        `UPDATE positions SET last_quote_lamports = ?, last_quote_at = ?, peak_quote_lamports = ?,
           consecutive_quote_failures = 0, unquotable_since = NULL
         WHERE id = ?`,
      )
      .run(valueLamports.toString(), at, peak.toString(), id);
  }

  /**
   * Failed sell quote. Increments the streak and, once it reaches
   * `unquotableAfter`, stamps `unquotable_since` (first time only).
   * Returns the updated position.
   */
  recordQuoteFailure(id: number, at: number, unquotableAfter: number): Position {
    this.db
      .prepare(
        `UPDATE positions SET
           consecutive_quote_failures = consecutive_quote_failures + 1,
           unquotable_since = CASE
             WHEN unquotable_since IS NULL AND consecutive_quote_failures + 1 >= ? THEN ?
             ELSE unquotable_since END
         WHERE id = ?`,
      )
      .run(unquotableAfter, at, id);
    return this.mustGet(id);
  }

  /** Records the first time the (possibly disabled) stop-loss would have fired. Returns true if newly set. */
  markShadowStopLoss(id: number, at: number, valueLamports: bigint): boolean {
    const res = this.db
      .prepare(
        `UPDATE positions SET shadow_sl_triggered_at = ?, shadow_sl_value_lamports = ?
         WHERE id = ? AND shadow_sl_triggered_at IS NULL`,
      )
      .run(at, valueLamports.toString(), id);
    return res.changes === 1;
  }

  /**
   * Applies a sell attempt: reduces the held amount by `soldRaw` (0 for a
   * failed attempt) and adds `netLamports` to realized proceeds. Net can be
   * negative when a failed on-chain attempt still paid fees.
   */
  applySell(id: number, soldRaw: bigint, netLamports: bigint): Position {
    const p = this.mustGet(id);
    if (p.status !== 'open') throw new Error(`position ${id} is not open`);
    if (soldRaw < 0n || soldRaw > p.tokenAmountRaw) {
      throw new RangeError(`invalid sell amount ${soldRaw} for position ${id} holding ${p.tokenAmountRaw}`);
    }
    this.db
      .prepare(`UPDATE positions SET token_amount_raw = ?, realized_lamports = ? WHERE id = ?`)
      .run(
        (p.tokenAmountRaw - soldRaw).toString(),
        (p.realizedLamports + netLamports).toString(),
        id,
      );
    return this.mustGet(id);
  }

  close(id: number, reason: ExitReason, at: number, exitSolUsd: number | null): void {
    const res = this.db
      .prepare(
        `UPDATE positions SET status = 'closed', exit_reason = ?, exited_at = ?, exit_sol_usd = ?
         WHERE id = ? AND status = 'open'`,
      )
      .run(reason, at, exitSolUsd, id);
    if (res.changes !== 1) throw new Error(`position ${id} is not open`);
  }

  private mustGet(id: number): Position {
    const p = this.get(id);
    if (!p) throw new Error(`position ${id} not found`);
    return p;
  }
}
