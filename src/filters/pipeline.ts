import type { Config, FilterName } from '../config/schema.js';
import type { FilterOutcome } from '../storage/types.js';
import type { FilterResultInput } from '../storage/audit.repo.js';
import { BudgetExhaustedError } from '../clients/errors.js';
import type { TokenContext } from './context.js';
import type { CheckResult, Filter } from './types.js';

export interface PipelineResult {
  verdict: 'passed' | 'rejected';
  rejectedBy: FilterName[];
  results: (FilterResultInput & { filter: FilterName })[];
}

/** Maps a filter's decision to the recorded outcome, applying the per-filter missing-data policy. */
export function toOutcome(r: CheckResult, policy: Config['filters'][FilterName]['onMissingData']): { outcome: FilterOutcome; rejects: boolean } {
  if (r.status === 'pass') return { outcome: 'pass', rejects: false };
  if (r.status === 'fail') return { outcome: 'fail', rejects: true };
  switch (policy) {
    case 'reject':
      return { outcome: 'insufficient_data', rejects: true };
    case 'skip':
      return { outcome: 'skipped', rejects: false };
    case 'warn':
      return { outcome: 'warn', rejects: false };
  }
}

/**
 * Runs filters in order. Each enabled filter yields one recorded result.
 * BudgetExhaustedError propagates (the caller must stop scanning); any other
 * exception inside a filter is treated as missing data for that filter.
 */
export async function runPipeline(
  ctx: TokenContext,
  filters: Filter[],
  opts: { stopOnFirstReject: boolean },
): Promise<PipelineResult> {
  const results: PipelineResult['results'] = [];
  const rejectedBy: FilterName[] = [];

  for (const f of filters) {
    const cfg = ctx.config.filters[f.name];
    if (!cfg.enabled) continue;
    let r: CheckResult;
    try {
      r = await f.check(ctx);
    } catch (e) {
      if (e instanceof BudgetExhaustedError) throw e;
      r = { status: 'missing', reason: `filter error: ${e instanceof Error ? e.message : String(e)}` };
    }
    const { outcome, rejects } = toOutcome(r, cfg.onMissingData);
    results.push({ filter: f.name, outcome, reason: r.reason, ...(r.data ? { data: r.data } : {}) });
    if (rejects) {
      rejectedBy.push(f.name);
      if (opts.stopOnFirstReject) break;
    }
  }
  return { verdict: rejectedBy.length ? 'rejected' : 'passed', rejectedBy, results };
}
