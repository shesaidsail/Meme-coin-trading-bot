import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { migrate } from './migrations.js';
import { PositionsRepo } from './positions.repo.js';
import { TradesRepo } from './trades.repo.js';
import { LedgerRepo } from './ledger.repo.js';
import { AuditRepo } from './audit.repo.js';
import { UsageRepo, RateObservationsRepo } from './usage.repo.js';
import { WatchlistRepo } from './watchlist.repo.js';
import { SnapshotsRepo } from './snapshots.repo.js';
import type { ExitReason, Mode, NewPosition, NewTrade, Position } from './types.js';
import type { Clock } from '../util/clock.js';

export class StorageError extends Error {
  override name = 'StorageError';
}

export interface OpenStorageOptions {
  path: string;
  mode: Mode;
  clock: Clock;
}

export type BuyTradeInput = Omit<NewTrade, 'positionId' | 'mint' | 'side' | 'mode' | 'createdAt'>;
export type SellTradeInput = Omit<NewTrade, 'positionId' | 'mint' | 'side' | 'mode' | 'createdAt'>;

export interface CloseInput {
  reason: ExitReason;
  exitSolUsd: number | null;
  /** Token-account rent returned when the emptied account is closed. */
  rentRefundLamports?: bigint;
}

/**
 * SQLite-backed persistence. All multi-table state changes go through the
 * methods here so each one is a single transaction: a crash can never leave
 * a position without its trade, or cash debited without a position.
 */
export class Storage {
  readonly positions: PositionsRepo;
  readonly trades: TradesRepo;
  readonly ledger: LedgerRepo;
  readonly audit: AuditRepo;
  readonly usage: UsageRepo;
  readonly snapshots: SnapshotsRepo;
  readonly watchlist: WatchlistRepo;
  readonly rateObservations: RateObservationsRepo;

  private constructor(
    readonly db: Database.Database,
    readonly mode: Mode,
    private readonly clock: Clock,
  ) {
    this.positions = new PositionsRepo(db);
    this.trades = new TradesRepo(db);
    this.ledger = new LedgerRepo(db);
    this.audit = new AuditRepo(db);
    this.usage = new UsageRepo(db);
    this.snapshots = new SnapshotsRepo(db);
    this.watchlist = new WatchlistRepo(db);
    this.rateObservations = new RateObservationsRepo(db);
  }

  static open(opts: OpenStorageOptions): Storage {
    if (opts.path !== ':memory:') mkdirSync(dirname(opts.path), { recursive: true });
    const db = new Database(opts.path);
    db.pragma('journal_mode = WAL');
    db.pragma('synchronous = FULL');
    db.pragma('foreign_keys = ON');
    db.pragma('busy_timeout = 5000');
    migrate(db, opts.clock.now());

    // A database belongs to exactly one mode, so paper results can never be
    // mistaken for (or mixed with) live positions.
    const row = db.prepare(`SELECT value FROM kv WHERE key = 'mode'`).get() as
      | { value: string }
      | undefined;
    if (!row) {
      db.prepare(`INSERT INTO kv (key, value) VALUES ('mode', ?)`).run(opts.mode);
    } else if (row.value !== opts.mode) {
      db.close();
      throw new StorageError(
        `database ${opts.path} was created in ${row.value} mode; refusing to open it in ${opts.mode} mode. ` +
          'Use a separate storage.path for each mode.',
      );
    }
    return new Storage(db, opts.mode, opts.clock);
  }

  close(): void {
    this.db.close();
  }

  getKv(key: string): string | null {
    const r = this.db.prepare('SELECT value FROM kv WHERE key = ?').get(key) as { value: string } | undefined;
    return r?.value ?? null;
  }

  setKv(key: string, value: string): void {
    this.db.prepare('INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value').run(key, value);
  }

  tx<T>(fn: () => T): T {
    return this.db.transaction(fn)();
  }

  /** Records a filled buy: trade row, position, cash debit and audit entry, atomically. */
  openPosition(position: NewPosition, buy: BuyTradeInput): { positionId: number; tradeId: number } {
    if (position.mode !== this.mode) throw new StorageError(`position mode ${position.mode} != ${this.mode}`);
    if (buy.status === 'failed') throw new StorageError('cannot open a position from a failed buy');
    const now = this.clock.now();
    return this.tx(() => {
      const positionId = this.positions.insert(position);
      const tradeId = this.trades.insert({
        ...buy,
        positionId,
        mint: position.mint,
        side: 'buy',
        mode: this.mode,
        createdAt: now,
      });
      this.ledger.append('buy', -position.costBasisLamports, now, {
        positionId,
        tradeId,
        note: position.symbol ?? position.mint,
      });
      this.audit.log('position_opened', now, {
        mint: position.mint,
        positionId,
        data: {
          symbol: position.symbol,
          tokenAmountRaw: position.tokenAmountRaw,
          costBasisLamports: position.costBasisLamports,
          tpGrossMultiplier: position.tpGrossMultiplier,
          tpTargetNetLamports: position.tpTargetNetLamports,
          timeStopAt: position.timeStopAt,
        },
      });
      return { positionId, tradeId };
    });
  }

  /** Records a buy attempt that did not produce a position (failed or abandoned). */
  recordFailedBuy(mint: string, buy: BuyTradeInput): number {
    const now = this.clock.now();
    return this.tx(() => {
      const tradeId = this.trades.insert({
        ...buy,
        positionId: null,
        mint,
        side: 'buy',
        mode: this.mode,
        createdAt: now,
      });
      if (buy.feeLamports > 0n) {
        // A failed on-chain transaction still pays its fees.
        this.ledger.append('buy', -buy.feeLamports, now, { tradeId, note: 'failed buy fee' });
      }
      this.audit.log('buy_failed', now, { level: 'warn', mint, data: { tradeId, error: buy.error } });
      return tradeId;
    });
  }

  /**
   * Records one sell attempt (filled, partial or failed). Net cash
   * (`outAmountRaw - feeLamports`) is credited, the position's token amount
   * is reduced by `inFilledRaw`, and optionally the position is closed.
   */
  recordSellAttempt(positionId: number, sell: SellTradeInput, close?: CloseInput): Position {
    const now = this.clock.now();
    return this.tx(() => {
      const p = this.positions.get(positionId);
      if (!p) throw new StorageError(`position ${positionId} not found`);
      if (p.status !== 'open') throw new StorageError(`position ${positionId} is not open`);
      if (sell.status === 'failed' && sell.inFilledRaw !== 0n) {
        throw new StorageError('a failed sell cannot have a filled amount');
      }

      const tradeId = this.trades.insert({
        ...sell,
        positionId,
        mint: p.mint,
        side: 'sell',
        mode: this.mode,
        createdAt: now,
      });

      const net = sell.outAmountRaw - sell.feeLamports;
      if (net !== 0n) {
        this.ledger.append('sell', net, now, { positionId, tradeId, note: sell.reason ?? null });
      }
      let updated = this.positions.applySell(positionId, sell.inFilledRaw, net);

      this.audit.log(sell.status === 'failed' ? 'sell_failed' : 'sell_fill', now, {
        level: sell.status === 'failed' ? 'warn' : 'info',
        mint: p.mint,
        positionId,
        data: {
          tradeId,
          status: sell.status,
          attempt: sell.attempt,
          slippageBps: sell.slippageBps,
          inAmountRaw: sell.inAmountRaw,
          inFilledRaw: sell.inFilledRaw,
          outAmountRaw: sell.outAmountRaw,
          remainingRaw: updated.tokenAmountRaw,
          error: sell.error,
        },
      });

      if (close) {
        const refund = close.rentRefundLamports ?? 0n;
        if (refund > 0n) {
          this.ledger.append('adjustment', refund, now, { positionId, note: 'token account rent refund' });
          updated = this.positions.applySell(positionId, 0n, refund);
        }
        this.positions.close(positionId, close.reason, now, close.exitSolUsd);
        updated = this.positions.get(positionId)!;
        this.audit.log('position_closed', now, {
          mint: p.mint,
          positionId,
          data: {
            reason: close.reason,
            costBasisLamports: updated.costBasisLamports,
            realizedLamports: updated.realizedLamports,
            pnlLamports: updated.realizedLamports - updated.costBasisLamports,
            remainingRaw: updated.tokenAmountRaw,
            heldMs: now - updated.enteredAt,
          },
        });
      }
      return updated;
    });
  }
}
