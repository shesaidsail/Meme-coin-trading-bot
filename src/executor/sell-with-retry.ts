import type { Config } from '../config/schema.js';
import type { Storage } from '../storage/store.js';
import type { ExitReason, Position } from '../storage/types.js';
import type { Logger } from '../util/logger.js';
import type { Clock } from '../util/clock.js';
import { realSleep, type Sleep } from '../clients/rate-limiter.js';
import { mulFrac } from '../util/units.js';
import type { Executor } from './types.js';

export interface SellOutcome {
  closed: boolean;
  position: Position;
  attempts: number;
}

/**
 * Sells a position, recording every attempt.
 *  - slippage failure → next attempt at +slippageStepBps, up to maxSlippageBps
 *  - no route → next attempt sells half as much
 *    (a partial fill), down to minChunkFraction of the position
 *  - a fill sells that chunk; selling continues with the remainder
 * The position closes when the remainder is at or below the dust threshold
 * (token-account rent is refunded then). If attempts run out, the position
 * stays open with whatever remains and the caller retries on a later pass.
 */
export async function sellWithRetry(
  position: Position,
  reason: ExitReason,
  deps: { executor: Executor; storage: Storage; config: Config; clock: Clock; logger: Logger; solUsd: number | null; sleep?: Sleep },
): Promise<SellOutcome> {
  const { executor, storage, config, logger } = deps;
  const s = config.execution.sell;
  const sleep = deps.sleep ?? realSleep;
  const dust = mulFrac(position.initialTokenAmountRaw, s.dustFraction);
  const minChunk = (() => {
    const m = mulFrac(position.tokenAmountRaw, s.minChunkFraction);
    return m > 0n ? m : 1n;
  })();

  let p = position;
  let slippage = s.initialSlippageBps;
  let chunk = p.tokenAmountRaw;

  for (let attempt = 1; attempt <= s.maxAttempts; attempt++) {
    const amount = chunk < p.tokenAmountRaw ? chunk : p.tokenAmountRaw;
    const r = await executor.sell(p.mint, { amount, slippageBps: slippage });
    const remainingAfter = p.tokenAmountRaw - r.inFilled;
    const closes = r.status === 'filled' && remainingAfter <= dust;

    p = storage.recordSellAttempt(
      p.id,
      {
        status: r.status === 'failed' ? 'failed' : remainingAfter > 0n && !closes ? 'partial' : 'filled',
        reason,
        attempt,
        slippageBps: slippage,
        inAmountRaw: amount,
        inFilledRaw: r.inFilled,
        outAmountRaw: r.out,
        quotedOutRaw: r.quotedOut,
        priceImpact: r.priceImpact,
        feeLamports: r.feeLamports,
        solUsd: deps.solUsd,
        signature: r.signature,
        error: r.error ?? null,
      },
      closes ? { reason, exitSolUsd: deps.solUsd, rentRefundLamports: BigInt(config.costs.ataRentLamports) } : undefined,
    );
    logger.info(
      { positionId: p.id, mint: p.mint, reason, attempt, slippageBps: slippage, amount, status: r.status, failure: r.failure, remaining: p.tokenAmountRaw },
      'sell_attempt',
    );
    if (closes) return { closed: true, position: p, attempts: attempt };

    if (r.status === 'failed') {
      if (r.failure === 'no_route') {
        const half = amount / 2n;
        chunk = half > minChunk ? half : minChunk;
      } else if (r.failure === 'slippage') {
        slippage = Math.min(slippage + s.slippageStepBps, s.maxSlippageBps);
      }
    }
    if (attempt < s.maxAttempts) await sleep(s.retryDelayMs);
  }

  storage.audit.log('sell_incomplete', deps.clock.now(), {
    level: 'warn',
    mint: p.mint,
    positionId: p.id,
    data: { reason, remainingRaw: p.tokenAmountRaw, attempts: s.maxAttempts },
  });
  logger.warn({ positionId: p.id, remaining: p.tokenAmountRaw }, 'sell_incomplete');
  return { closed: false, position: p, attempts: s.maxAttempts };
}
