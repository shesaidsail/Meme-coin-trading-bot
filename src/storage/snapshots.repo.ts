import type Database from 'better-sqlite3';

export interface EquitySnapshot {
  ts: number;
  cashLamports: bigint;
  positionsLamports: bigint;
  equityLamports: bigint;
  solUsd: number | null;
  openPositions: number;
  unquotablePositions: number;
}

interface Row {
  ts: number;
  cash_lamports: string;
  positions_lamports: string;
  equity_lamports: string;
  sol_usd: number | null;
  open_positions: number;
  unquotable_positions: number;
}

const fromRow = (r: Row): EquitySnapshot => ({
  ts: r.ts,
  cashLamports: BigInt(r.cash_lamports),
  positionsLamports: BigInt(r.positions_lamports),
  equityLamports: BigInt(r.equity_lamports),
  solUsd: r.sol_usd,
  openPositions: r.open_positions,
  unquotablePositions: r.unquotable_positions,
});

export class SnapshotsRepo {
  constructor(private readonly db: Database.Database) {}

  insert(s: EquitySnapshot): void {
    this.db
      .prepare(
        `INSERT INTO equity_snapshots
           (ts, cash_lamports, positions_lamports, equity_lamports, sol_usd, open_positions, unquotable_positions)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        s.ts,
        s.cashLamports.toString(),
        s.positionsLamports.toString(),
        s.equityLamports.toString(),
        s.solUsd,
        s.openPositions,
        s.unquotablePositions,
      );
  }

  latest(): EquitySnapshot | null {
    const r = this.db.prepare('SELECT * FROM equity_snapshots ORDER BY ts DESC, id DESC LIMIT 1').get() as
      | Row
      | undefined;
    return r ? fromRow(r) : null;
  }

  first(): EquitySnapshot | null {
    const r = this.db.prepare('SELECT * FROM equity_snapshots ORDER BY ts, id LIMIT 1').get() as
      | Row
      | undefined;
    return r ? fromRow(r) : null;
  }
}
