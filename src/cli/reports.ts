import type { Storage } from '../storage/store.js';
import type { Config, ApiName } from '../config/schema.js';
import type { Evaluation } from '../engine/evaluate.js';
import { table, truncate } from './format.js';

/** Per-filter outcomes. "fail" = real failures; "no data" = rejected for insufficient data. */
export function filterOutcomeReport(storage: Storage, sinceTs = 0): string {
  const counts = storage.audit.filterOutcomeCounts(sinceTs);
  const rows = Object.entries(counts).map(([f, c]) => [f, c.pass, c.fail, c.insufficient_data, c.warn, c.skipped]);
  return table(['filter', 'pass', 'fail', 'no data (rejected)', 'warn', 'skipped'], rows);
}

export function evaluationsReport(evals: Evaluation[]): string {
  const rows = evals.map((e) => {
    const last = e.result.results.find((r) => e.result.rejectedBy.includes(r.filter as never)) ?? e.result.results.at(-1);
    return [
      truncate(e.candidate.symbol ?? '?', 10),
      e.candidate.mint.slice(0, 8),
      `$${Math.round(e.candidate.marketCapUsd / 1000)}k`,
      e.candidate.primaryPair.dexId,
      e.result.verdict,
      e.result.rejectedBy.join(',') || '-',
      truncate(last?.reason ?? '', 70),
    ];
  });
  return table(['symbol', 'mint', 'mcap', 'dex', 'verdict', 'rejected by', 'reason'], rows);
}

/** Distribution of RugCheck normalised risk scores among reports fetched in this batch. */
export async function rugcheckScoreDistribution(evals: Evaluation[]): Promise<string> {
  const scores: number[] = [];
  let unavailable = 0;
  for (const e of evals) {
    // Only reports already fetched by the filters; never triggers new API calls.
    const cached = e.ctx.cachedRugcheck();
    if (!cached) continue;
    const r = await cached;
    if (r.ok && typeof r.value.score_normalised === 'number') scores.push(r.value.score_normalised);
    else unavailable++;
  }
  if (!scores.length) return `No RugCheck scores in this batch (${unavailable} unavailable).`;
  const buckets = [0, 10, 20, 30, 40, 50, 60, 70, 80, 90];
  const rows = buckets.map((lo) => {
    const hi = lo + 10;
    const n = scores.filter((s) => s >= lo && (hi === 100 ? s <= 100 : s < hi)).length;
    return [`${lo}-${hi === 100 ? 100 : hi - 1}`, n, '#'.repeat(n)];
  });
  const sorted = [...scores].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)]!;
  return `${table(['score', 'n', ''], rows)}\nn=${scores.length}, min=${sorted[0]}, median=${median}, max=${sorted.at(-1)}, unavailable=${unavailable}`;
}

export function apiUsageReport(storage: Storage, config: Config, now: number): string {
  const names = Object.keys(config.apis) as ApiName[];
  const rows = names.map((n) => {
    const u = storage.usage.get(n, now);
    const b = config.apis[n].budget;
    return [n, u.calls, `${u.units}/${b.unitsPerDay}`, `${((u.units / b.unitsPerDay) * 100).toFixed(1)}%`, u.throttled, u.errors];
  });
  const out = [`API usage today (UTC ${new Date(now).toISOString().slice(0, 10)}):`, table(['provider', 'calls', 'units/budget', 'used', '429s', 'errors'], rows), '', 'Latest rate-limit headers seen:'];
  for (const p of storage.rateObservations.providers()) {
    const [o] = storage.rateObservations.latest(p);
    if (o) out.push(`  ${p} @ ${new Date(o.ts).toISOString()} ${o.endpoint} [${o.status}] ${JSON.stringify(o.headers)}`);
  }
  return out.join('\n');
}
