import type { Config } from '../config/schema.js';
import type { Clients } from '../clients/index.js';
import { BudgetExhaustedError } from '../clients/errors.js';
import type { Storage } from '../storage/store.js';
import type { Clock } from '../util/clock.js';
import type { Logger } from '../util/logger.js';
import type { Candidate } from '../scanner/types.js';
import { TokenContext } from '../filters/context.js';
import { runPipeline, type PipelineResult } from '../filters/pipeline.js';
import type { Filter } from '../filters/types.js';

export interface Evaluation {
  candidate: Candidate;
  result: PipelineResult;
  ctx: TokenContext;
}

export interface EvaluateDeps {
  config: Config;
  clients: Pick<Clients, 'rpc' | 'rugcheck' | 'jupiter'>;
  storage: Storage;
  clock: Clock;
  logger: Logger;
  filters: Filter[];
}

/**
 * Runs the filter pipeline over candidates and records every evaluation
 * (with per-filter outcomes) in SQLite. Stops early, returning what it has,
 * if an API budget is exhausted.
 */
export async function evaluateCandidates(
  candidates: Candidate[],
  scanId: string,
  intendedSizeLamports: bigint,
  deps: EvaluateDeps,
  opts: { stopOnFirstReject?: boolean } = {},
): Promise<{ evaluations: Evaluation[]; budgetExhausted: string | null }> {
  const stopOnFirstReject = opts.stopOnFirstReject ?? deps.config.pipeline.stopOnFirstReject;
  const evaluations: Evaluation[] = [];
  for (const c of candidates) {
    const ctx = new TokenContext(c, { config: deps.config, clients: deps.clients, clock: deps.clock, intendedSizeLamports });
    let result: PipelineResult;
    try {
      result = await runPipeline(ctx, deps.filters, { stopOnFirstReject });
    } catch (e) {
      if (e instanceof BudgetExhaustedError) {
        deps.logger.warn({ err: e, mint: c.mint }, 'budget_exhausted_stopping_evaluation');
        deps.storage.audit.log('budget_exhausted', deps.clock.now(), { level: 'warn', mint: c.mint, data: { message: e.message } });
        return { evaluations, budgetExhausted: e.message };
      }
      throw e;
    }
    deps.storage.audit.recordEvaluation(
      {
        scanId,
        mint: c.mint,
        symbol: c.symbol,
        mcapUsd: c.marketCapUsd,
        liquidityUsd: c.primaryPair.liquidityUsd,
        verdict: result.verdict,
        rejectedBy: result.rejectedBy,
        decision: null,
        results: result.results,
      },
      deps.clock.now(),
    );
    deps.logger.info(
      { mint: c.mint, symbol: c.symbol, verdict: result.verdict, rejectedBy: result.rejectedBy, reason: result.results.at(-1)?.reason },
      'token_evaluated',
    );
    evaluations.push({ candidate: c, result, ctx });
  }
  return { evaluations, budgetExhausted: null };
}
