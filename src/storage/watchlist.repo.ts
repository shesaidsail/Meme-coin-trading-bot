import type Database from 'better-sqlite3';

export interface WatchEntry {
  mint: string;
  /** The first source that reported this mint. */
  source: string;
  firstSeenAt: number;
  lastSeenAt: number;
  lastCheckedAt: number | null;
  checks: number;
  /** Not priced before this time; null = eligible now. */
  eligibleAt: number | null;
}

export interface WatchInput {
  mint: string;
  source: string;
  /** Earliest time the mint should be priced (e.g. pool creation + minimum age). */
  eligibleAt?: number | null;
}

interface Row {
  mint: string;
  source: string;
  first_seen_at: number;
  last_seen_at: number;
  last_checked_at: number | null;
  checks: number;
  eligible_at: number | null;
}

const fromRow = (r: Row): WatchEntry => ({
  mint: r.mint,
  source: r.source,
  firstSeenAt: r.first_seen_at,
  lastSeenAt: r.last_seen_at,
  lastCheckedAt: r.last_checked_at,
  checks: r.checks,
  eligibleAt: r.eligible_at,
});

export interface SourceYield {
  source: string;
  /** Mints this source reported in the window. */
  discovered: number;
  /** ...of which this source was the first to report. */
  firstToReport: number;
  /** Mints from this source that reached the filter pipeline (in band, eligible). */
  evaluated: number;
  passed: number;
}

export class WatchlistRepo {
  constructor(private readonly db: Database.Database) {}

  /**
   * Adds mints and records each (mint, source) sighting. For known mints only
   * last_seen_at is bumped, and eligibility moves earlier, never later: a mint
   * that any source reports as eligible now is eligible now.
   * Returns how many mints were new to the watchlist.
   */
  upsertMany(entries: WatchInput[], at: number): number {
    const exists = this.db.prepare('SELECT eligible_at FROM watchlist WHERE mint = ?');
    const insert = this.db.prepare(
      'INSERT INTO watchlist (mint, source, first_seen_at, last_seen_at, eligible_at) VALUES (?, ?, ?, ?, ?)',
    );
    const touch = this.db.prepare('UPDATE watchlist SET last_seen_at = ?, eligible_at = ? WHERE mint = ?');
    const sighting = this.db.prepare(
      'INSERT OR IGNORE INTO watchlist_sources (mint, source, first_seen_at) VALUES (?, ?, ?)',
    );
    let added = 0;
    this.db.transaction(() => {
      for (const e of entries) {
        const eligible = e.eligibleAt ?? null;
        const row = exists.get(e.mint) as { eligible_at: number | null } | undefined;
        if (!row) {
          insert.run(e.mint, e.source, at, at, eligible);
          added++;
        } else {
          const merged = row.eligible_at === null || eligible === null ? null : Math.min(row.eligible_at, eligible);
          touch.run(at, merged, e.mint);
        }
        sighting.run(e.mint, e.source, at);
      }
    })();
    return added;
  }

  /**
   * Mints due for a market-data check at `now`: eligible, never checked or
   * last checked before `checkedBefore`, and first seen after `seenAfter`.
   * Never-checked first, then least recently checked.
   */
  listDue(opts: { now: number; checkedBefore: number; seenAfter: number; limit: number }): WatchEntry[] {
    return (
      this.db
        .prepare(
          `SELECT * FROM watchlist
           WHERE (last_checked_at IS NULL OR last_checked_at < ?)
             AND first_seen_at >= ?
             AND (eligible_at IS NULL OR eligible_at <= ?)
           ORDER BY COALESCE(last_checked_at, 0), first_seen_at DESC
           LIMIT ?`,
        )
        .all(opts.checkedBefore, opts.seenAfter, opts.now, opts.limit) as Row[]
    ).map(fromRow);
  }

  markChecked(mints: string[], at: number): void {
    const upd = this.db.prepare('UPDATE watchlist SET last_checked_at = ?, checks = checks + 1 WHERE mint = ?');
    this.db.transaction(() => {
      for (const m of mints) upd.run(at, m);
    })();
  }

  get(mint: string): WatchEntry | null {
    const r = this.db.prepare('SELECT * FROM watchlist WHERE mint = ?').get(mint) as Row | undefined;
    return r ? fromRow(r) : null;
  }

  sourcesOf(mint: string): string[] {
    return (
      this.db.prepare('SELECT source FROM watchlist_sources WHERE mint = ? ORDER BY first_seen_at, source').all(mint) as {
        source: string;
      }[]
    ).map((r) => r.source);
  }

  /** Removes entries first seen before `cutoff`. */
  prune(cutoff: number): number {
    return this.db.prepare('DELETE FROM watchlist WHERE first_seen_at < ?').run(cutoff).changes;
  }

  count(): number {
    return (this.db.prepare('SELECT COUNT(*) AS n FROM watchlist').get() as { n: number }).n;
  }

  /** Earliest sighting at or after `since` (to size the reporting window). */
  earliestSighting(since: number): number | null {
    return (this.db.prepare('SELECT MIN(first_seen_at) AS t FROM watchlist_sources WHERE first_seen_at >= ?').get(since) as { t: number | null }).t;
  }

  /**
   * Per-source yield for mints first reported by that source at or after
   * `since`. A mint reported by several sources counts for each of them;
   * `firstToReport` shows which source found it first.
   */
  sourceYield(since: number): SourceYield[] {
    return this.db
      .prepare(
        `SELECT s.source AS source,
                COUNT(*) AS discovered,
                SUM(CASE WHEN s.first_seen_at = (SELECT MIN(first_seen_at) FROM watchlist_sources x WHERE x.mint = s.mint) THEN 1 ELSE 0 END) AS firstToReport,
                SUM(CASE WHEN EXISTS (SELECT 1 FROM evaluations e WHERE e.mint = s.mint AND e.ts >= s.first_seen_at) THEN 1 ELSE 0 END) AS evaluated,
                SUM(CASE WHEN EXISTS (SELECT 1 FROM evaluations e WHERE e.mint = s.mint AND e.ts >= s.first_seen_at AND e.verdict = 'passed') THEN 1 ELSE 0 END) AS passed
         FROM watchlist_sources s
         WHERE s.first_seen_at >= ?
         GROUP BY s.source
         ORDER BY evaluated DESC, discovered DESC`,
      )
      .all(since) as SourceYield[];
  }
}
