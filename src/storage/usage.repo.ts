import type Database from 'better-sqlite3';

export interface ApiUsage {
  provider: string;
  day: string;
  units: number;
  calls: number;
  throttled: number;
  errors: number;
}

/** UTC calendar day, e.g. "2026-10-14". Budgets reset at 00:00 UTC. */
export function utcDay(ts: number): string {
  return new Date(ts).toISOString().slice(0, 10);
}

export class UsageRepo {
  constructor(private readonly db: Database.Database) {}

  add(
    provider: string,
    at: number,
    delta: Partial<Pick<ApiUsage, 'units' | 'calls' | 'throttled' | 'errors'>>,
  ): void {
    this.db
      .prepare(
        `INSERT INTO api_usage (provider, day, units, calls, throttled, errors) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (provider, day) DO UPDATE SET
           units = units + excluded.units,
           calls = calls + excluded.calls,
           throttled = throttled + excluded.throttled,
           errors = errors + excluded.errors`,
      )
      .run(
        provider,
        utcDay(at),
        delta.units ?? 0,
        delta.calls ?? 0,
        delta.throttled ?? 0,
        delta.errors ?? 0,
      );
  }

  get(provider: string, at: number): ApiUsage {
    const day = utcDay(at);
    const r = this.db
      .prepare('SELECT * FROM api_usage WHERE provider = ? AND day = ?')
      .get(provider, day) as ApiUsage | undefined;
    return r ?? { provider, day, units: 0, calls: 0, throttled: 0, errors: 0 };
  }

  listDay(at: number): ApiUsage[] {
    return this.db
      .prepare('SELECT * FROM api_usage WHERE day = ? ORDER BY provider')
      .all(utcDay(at)) as ApiUsage[];
  }
}

export interface RateObservation {
  ts: number;
  provider: string;
  endpoint: string;
  status: number;
  headers: Record<string, string>;
}

export class RateObservationsRepo {
  constructor(private readonly db: Database.Database) {}

  insert(o: RateObservation): void {
    this.db
      .prepare(
        'INSERT INTO api_rate_observations (ts, provider, endpoint, status, headers) VALUES (?, ?, ?, ?, ?)',
      )
      .run(o.ts, o.provider, o.endpoint, o.status, JSON.stringify(o.headers));
  }

  latest(provider: string, limit = 1): RateObservation[] {
    return (
      this.db
        .prepare('SELECT * FROM api_rate_observations WHERE provider = ? ORDER BY id DESC LIMIT ?')
        .all(provider, limit) as {
        ts: number;
        provider: string;
        endpoint: string;
        status: number;
        headers: string;
      }[]
    ).map((r) => ({ ...r, headers: JSON.parse(r.headers) as Record<string, string> }));
  }

  count429(provider: string, sinceTs: number): number {
    return (
      this.db
        .prepare(
          'SELECT COUNT(*) AS n FROM api_rate_observations WHERE provider = ? AND status = 429 AND ts >= ?',
        )
        .get(provider, sinceTs) as { n: number }
    ).n;
  }

  providers(): string[] {
    return (
      this.db.prepare('SELECT DISTINCT provider FROM api_rate_observations ORDER BY provider').all() as {
        provider: string;
      }[]
    ).map((r) => r.provider);
  }
}
