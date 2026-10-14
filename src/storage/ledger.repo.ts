import type Database from 'better-sqlite3';

export type LedgerKind = 'initial' | 'buy' | 'sell' | 'adjustment';

/**
 * Append-only SOL cash ledger. Each row carries the running balance, so the
 * current balance is the last row and the full history is auditable.
 */
export class LedgerRepo {
  constructor(private readonly db: Database.Database) {}

  isInitialised(): boolean {
    return !!this.db.prepare('SELECT 1 FROM cash_ledger LIMIT 1').get();
  }

  /** Seeds the starting balance once. Later calls (e.g. after a restart) are no-ops. */
  initialise(startingLamports: bigint, at: number): boolean {
    if (this.isInitialised()) return false;
    if (startingLamports <= 0n) throw new RangeError('starting balance must be positive');
    this.db
      .prepare(
        `INSERT INTO cash_ledger (ts, kind, delta_lamports, balance_lamports, note)
         VALUES (?, 'initial', ?, ?, 'starting balance')`,
      )
      .run(at, startingLamports.toString(), startingLamports.toString());
    return true;
  }

  balance(): bigint {
    const r = this.db
      .prepare('SELECT balance_lamports FROM cash_ledger ORDER BY id DESC LIMIT 1')
      .get() as { balance_lamports: string } | undefined;
    if (!r) throw new Error('cash ledger not initialised');
    return BigInt(r.balance_lamports);
  }

  /** Starting balance (first ledger row). */
  initialBalance(): bigint {
    const r = this.db
      .prepare(`SELECT delta_lamports FROM cash_ledger WHERE kind = 'initial' ORDER BY id LIMIT 1`)
      .get() as { delta_lamports: string } | undefined;
    if (!r) throw new Error('cash ledger not initialised');
    return BigInt(r.delta_lamports);
  }

  /**
   * Appends a movement. Negative delta = cash out. Refuses to go negative:
   * an entry that would overdraw is a sizing bug and must not be recorded.
   */
  append(
    kind: Exclude<LedgerKind, 'initial'>,
    deltaLamports: bigint,
    at: number,
    refs: { positionId?: number | null; tradeId?: number | null; note?: string | null } = {},
  ): bigint {
    const next = this.balance() + deltaLamports;
    if (next < 0n) {
      throw new RangeError(`ledger would go negative: balance ${this.balance()} + ${deltaLamports}`);
    }
    this.db
      .prepare(
        `INSERT INTO cash_ledger (ts, kind, delta_lamports, balance_lamports, position_id, trade_id, note)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        at,
        kind,
        deltaLamports.toString(),
        next.toString(),
        refs.positionId ?? null,
        refs.tradeId ?? null,
        refs.note ?? null,
      );
    return next;
  }
}
