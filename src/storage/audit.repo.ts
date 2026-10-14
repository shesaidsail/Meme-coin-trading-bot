import type Database from 'better-sqlite3';
import type { AuditLevel, FilterOutcome } from './types.js';
import { redactString } from '../util/redact.js';

export interface AuditEntry {
  id: number;
  ts: number;
  level: AuditLevel;
  event: string;
  mint: string | null;
  positionId: number | null;
  data: unknown;
}

export interface FilterResultInput {
  filter: string;
  outcome: FilterOutcome;
  reason: string | null;
  data?: unknown;
}

export interface EvaluationInput {
  scanId: string;
  mint: string;
  symbol: string | null;
  mcapUsd: number | null;
  liquidityUsd: number | null;
  verdict: 'passed' | 'rejected';
  /** Name(s) of the filter(s) that rejected the token. */
  rejectedBy: string[];
  decision: string | null;
  results: FilterResultInput[];
}

export type FilterOutcomeCounts = Record<FilterOutcome, number>;

/** Serialises arbitrary data for storage, converting bigints and scrubbing credentials. */
function toJson(data: unknown): string | null {
  if (data === undefined) return null;
  const s = JSON.stringify(data, (_k, v) => (typeof v === 'bigint' ? v.toString() : v));
  return s === undefined ? null : redactString(s);
}

export class AuditRepo {
  constructor(private readonly db: Database.Database) {}

  log(
    event: string,
    at: number,
    opts: { level?: AuditLevel; mint?: string | null; positionId?: number | null; data?: unknown } = {},
  ): number {
    const res = this.db
      .prepare(
        'INSERT INTO audit_log (ts, level, event, mint, position_id, data) VALUES (?, ?, ?, ?, ?, ?)',
      )
      .run(at, opts.level ?? 'info', event, opts.mint ?? null, opts.positionId ?? null, toJson(opts.data));
    return Number(res.lastInsertRowid);
  }

  list(opts: { event?: string; positionId?: number; limit?: number } = {}): AuditEntry[] {
    const where: string[] = [];
    const args: unknown[] = [];
    if (opts.event) {
      where.push('event = ?');
      args.push(opts.event);
    }
    if (opts.positionId !== undefined) {
      where.push('position_id = ?');
      args.push(opts.positionId);
    }
    const sql = `SELECT * FROM audit_log ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
                 ORDER BY id DESC LIMIT ?`;
    args.push(opts.limit ?? 100);
    return (
      this.db.prepare(sql).all(...args) as {
        id: number;
        ts: number;
        level: AuditLevel;
        event: string;
        mint: string | null;
        position_id: number | null;
        data: string | null;
      }[]
    ).map((r) => ({
      id: r.id,
      ts: r.ts,
      level: r.level,
      event: r.event,
      mint: r.mint,
      positionId: r.position_id,
      data: r.data === null ? null : JSON.parse(r.data),
    }));
  }

  /** Stores one token evaluation and all its per-filter results atomically. */
  recordEvaluation(e: EvaluationInput, at: number): number {
    return this.db.transaction(() => {
      const res = this.db
        .prepare(
          `INSERT INTO evaluations (ts, scan_id, mint, symbol, mcap_usd, liquidity_usd, verdict, rejected_by, decision)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          at,
          e.scanId,
          e.mint,
          e.symbol,
          e.mcapUsd,
          e.liquidityUsd,
          e.verdict,
          e.rejectedBy.length ? e.rejectedBy.join(',') : null,
          e.decision,
        );
      const evaluationId = Number(res.lastInsertRowid);
      const ins = this.db.prepare(
        `INSERT INTO filter_results (evaluation_id, ts, mint, filter, outcome, reason, data)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      );
      for (const r of e.results) {
        ins.run(evaluationId, at, e.mint, r.filter, r.outcome, r.reason, toJson(r.data));
      }
      return evaluationId;
    })();
  }

  /** Most recent evaluation time for a mint, to avoid re-checking it every scan. */
  lastEvaluatedAt(mint: string): number | null {
    const r = this.db
      .prepare('SELECT MAX(ts) AS ts FROM evaluations WHERE mint = ?')
      .get(mint) as { ts: number | null };
    return r.ts;
  }

  /**
   * Per-filter outcome counts. `fail` (real failures) and `insufficient_data`
   * (filter starved of data) are kept separate so data gaps are visible.
   */
  filterOutcomeCounts(sinceTs = 0): Record<string, FilterOutcomeCounts> {
    const rows = this.db
      .prepare(
        `SELECT filter, outcome, COUNT(*) AS n FROM filter_results WHERE ts >= ?
         GROUP BY filter, outcome ORDER BY filter`,
      )
      .all(sinceTs) as { filter: string; outcome: FilterOutcome; n: number }[];
    const out: Record<string, FilterOutcomeCounts> = {};
    for (const r of rows) {
      out[r.filter] ??= { pass: 0, fail: 0, insufficient_data: 0, skipped: 0, warn: 0 };
      out[r.filter]![r.outcome] = r.n;
    }
    return out;
  }

  evaluationCounts(sinceTs = 0): { passed: number; rejected: number } {
    const rows = this.db
      .prepare('SELECT verdict, COUNT(*) AS n FROM evaluations WHERE ts >= ? GROUP BY verdict')
      .all(sinceTs) as { verdict: 'passed' | 'rejected'; n: number }[];
    const out = { passed: 0, rejected: 0 };
    for (const r of rows) out[r.verdict] = r.n;
    return out;
  }
}
