import type Database from 'better-sqlite3';
import type { NewTrade, Trade } from './types.js';

interface Row {
  id: number;
  position_id: number | null;
  mint: string;
  side: Trade['side'];
  mode: Trade['mode'];
  status: Trade['status'];
  reason: string | null;
  attempt: number;
  slippage_bps: number | null;
  in_amount_raw: string;
  in_filled_raw: string;
  out_amount_raw: string;
  quoted_out_raw: string | null;
  price_impact: number | null;
  fee_lamports: string;
  sol_usd: number | null;
  signature: string | null;
  error: string | null;
  created_at: number;
}

function fromRow(r: Row): Trade {
  return {
    id: r.id,
    positionId: r.position_id,
    mint: r.mint,
    side: r.side,
    mode: r.mode,
    status: r.status,
    reason: r.reason,
    attempt: r.attempt,
    slippageBps: r.slippage_bps,
    inAmountRaw: BigInt(r.in_amount_raw),
    inFilledRaw: BigInt(r.in_filled_raw),
    outAmountRaw: BigInt(r.out_amount_raw),
    quotedOutRaw: r.quoted_out_raw === null ? null : BigInt(r.quoted_out_raw),
    priceImpact: r.price_impact,
    feeLamports: BigInt(r.fee_lamports),
    solUsd: r.sol_usd,
    signature: r.signature,
    error: r.error,
    createdAt: r.created_at,
  };
}

export class TradesRepo {
  constructor(private readonly db: Database.Database) {}

  insert(t: NewTrade): number {
    const res = this.db
      .prepare(
        `INSERT INTO trades (
          position_id, mint, side, mode, status, reason, attempt, slippage_bps, in_amount_raw,
          in_filled_raw, out_amount_raw, quoted_out_raw, price_impact, fee_lamports, sol_usd,
          signature, error, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        t.positionId,
        t.mint,
        t.side,
        t.mode,
        t.status,
        t.reason,
        t.attempt,
        t.slippageBps,
        t.inAmountRaw.toString(),
        t.inFilledRaw.toString(),
        t.outAmountRaw.toString(),
        t.quotedOutRaw?.toString() ?? null,
        t.priceImpact,
        t.feeLamports.toString(),
        t.solUsd,
        t.signature,
        t.error,
        t.createdAt,
      );
    return Number(res.lastInsertRowid);
  }

  setPosition(tradeId: number, positionId: number): void {
    this.db.prepare('UPDATE trades SET position_id = ? WHERE id = ?').run(positionId, tradeId);
  }

  listByPosition(positionId: number): Trade[] {
    return (
      this.db
        .prepare('SELECT * FROM trades WHERE position_id = ? ORDER BY id')
        .all(positionId) as Row[]
    ).map(fromRow);
  }
}
