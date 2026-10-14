import type Database from 'better-sqlite3';

export interface WatchEntry {
  mint: string;
  source: string;
  firstSeenAt: number;
  lastSeenAt: number;
  lastCheckedAt: number | null;
  checks: number;
}

interface Row {
  mint: string;
  source: string;
  first_seen_at: number;
  last_seen_at: number;
  last_checked_at: number | null;
  checks: number;
}

const fromRow = (r: Row): WatchEntry => ({
  mint: r.mint,
  source: r.source,
  firstSeenAt: r.first_seen_at,
  lastSeenAt: r.last_seen_at,
  lastCheckedAt: r.last_checked_at,
  checks: r.checks,
});

export class WatchlistRepo {
  constructor(private readonly db: Database.Database) {}

  /** Adds new mints; for known ones only bumps last_seen_at. Returns how many were new. */
  upsertMany(entries: { mint: string; source: string }[], at: number): number {
    const ins = this.db.prepare(
      `INSERT INTO watchlist (mint, source, first_seen_at, last_seen_at) VALUES (?, ?, ?, ?)
       ON CONFLICT (mint) DO UPDATE SET last_seen_at = excluded.last_seen_at`,
    );
    const exists = this.db.prepare('SELECT 1 FROM watchlist WHERE mint = ?');
    let added = 0;
    this.db.transaction(() => {
      for (const e of entries) {
        if (!exists.get(e.mint)) added++;
        ins.run(e.mint, e.source, at, at);
      }
    })();
    return added;
  }

  /**
   * Mints due for a market-data check: never checked, or last checked before
   * `checkedBefore`; and first seen after `seenAfter` (older entries expire).
   * Least recently checked first.
   */
  listDue(opts: { checkedBefore: number; seenAfter: number; limit: number }): WatchEntry[] {
    return (
      this.db
        .prepare(
          `SELECT * FROM watchlist
           WHERE (last_checked_at IS NULL OR last_checked_at < ?) AND first_seen_at >= ?
           ORDER BY COALESCE(last_checked_at, 0), first_seen_at DESC
           LIMIT ?`,
        )
        .all(opts.checkedBefore, opts.seenAfter, opts.limit) as Row[]
    ).map(fromRow);
  }

  markChecked(mints: string[], at: number): void {
    const upd = this.db.prepare(
      'UPDATE watchlist SET last_checked_at = ?, checks = checks + 1 WHERE mint = ?',
    );
    this.db.transaction(() => {
      for (const m of mints) upd.run(at, m);
    })();
  }

  get(mint: string): WatchEntry | null {
    const r = this.db.prepare('SELECT * FROM watchlist WHERE mint = ?').get(mint) as Row | undefined;
    return r ? fromRow(r) : null;
  }

  /** Removes entries first seen before `cutoff`. */
  prune(cutoff: number): number {
    return this.db.prepare('DELETE FROM watchlist WHERE first_seen_at < ?').run(cutoff).changes;
  }

  count(): number {
    return (this.db.prepare('SELECT COUNT(*) AS n FROM watchlist').get() as { n: number }).n;
  }
}
