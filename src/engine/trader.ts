import type { Config } from '../config/schema.js';
import type { JupiterClient } from '../clients/jupiter.js';
import type { Storage } from '../storage/store.js';
import type { ExitReason, Position } from '../storage/types.js';
import type { Clock } from '../util/clock.js';
import type { Logger } from '../util/logger.js';
import type { Sleep } from '../clients/rate-limiter.js';
import type { Candidate } from '../scanner/types.js';
import type { Executor } from '../executor/types.js';
import { sellWithRetry, type SellOutcome } from '../executor/sell-with-retry.js';
import { checkEntry } from '../risk/sizing.js';
import type { Equity } from '../risk/equity.js';
import { grossMultiplier, sideCostFraction, stopLossThreshold, takeProfitTarget } from '../risk/exit-math.js';
import { HOUR_MS } from '../util/clock.js';
import { ratio } from '../util/units.js';

export type EntryOutcome =
  | { entered: true; positionId: number; costBasisLamports: bigint; tpGrossMultiplier: number }
  | { entered: false; reason: string; detail: string };

export interface TraderDeps {
  config: Config;
  executor: Executor;
  jupiter: Pick<JupiterClient, 'quote'>;
  storage: Storage;
  clock: Clock;
  logger: Logger;
  sleep?: Sleep;
}

/** Opens and closes positions: applies the risk rules, executes, and records everything. */
export class Trader {
  constructor(private readonly deps: TraderDeps) {}

  /** `tokenDecimals` comes from the mint lookup the filters already made. */
  async enter(c: Candidate, equity: Equity, opts: { solUsd: number | null; tokenDecimals: number }): Promise<EntryOutcome> {
    const { solUsd } = opts;
    const { config, executor, storage, clock, logger } = this.deps;
    const check = checkEntry(equity, config);
    if (!check.ok) {
      storage.audit.log('entry_skipped', clock.now(), { mint: c.mint, data: { reason: check.reason, detail: check.detail } });
      return { entered: false, reason: check.reason, detail: check.detail };
    }

    const buy = await executor.buy(c.mint, { amount: check.swapLamports, slippageBps: config.execution.buySlippageBps });
    const tradeBase = {
      reason: 'entry',
      attempt: 1,
      slippageBps: config.execution.buySlippageBps,
      inAmountRaw: check.swapLamports,
      inFilledRaw: buy.inFilled,
      outAmountRaw: buy.out,
      quotedOutRaw: buy.quotedOut,
      priceImpact: buy.priceImpact,
      feeLamports: buy.feeLamports,
      solUsd,
      signature: buy.signature,
      error: buy.error ?? null,
    };
    if (buy.status !== 'filled' || buy.out <= 0n) {
      storage.recordFailedBuy(c.mint, { ...tradeBase, status: 'failed' });
      logger.warn({ mint: c.mint, failure: buy.failure, error: buy.error }, 'buy_failed');
      return { entered: false, reason: `buy_${buy.failure ?? 'failed'}`, detail: buy.error ?? '' };
    }

    const rent = BigInt(config.costs.ataRentLamports);
    const costBasis = buy.inFilled + buy.feeLamports + rent;

    // Buy side: actual costs (quoted impact + shortfall vs. the decision quote + fees).
    const shortfall = buy.quotedOut && buy.quotedOut > 0n ? Math.max(0, 1 - ratio(buy.out, buy.quotedOut)) : 0;
    const buyCost =
      sideCostFraction({
        swapFeeBps: config.costs.swapFeeBps,
        slippageBps: 0,
        priceImpact: buy.priceImpact ?? 0,
        priorityFeeLamports: buy.feeLamports,
        sizeLamports: buy.inFilled,
      }) + shortfall;

    // Sell side: estimated from a sell quote for exactly what we now hold.
    let sellImpact = 0;
    try {
      const sq = await this.deps.jupiter.quote({
        inputMint: c.mint,
        outputMint: config.chain.solMint,
        amount: buy.out,
        slippageBps: config.execution.sell.initialSlippageBps,
        priority: 'critical',
      });
      if (sq.ok) sellImpact = sq.quote.priceImpact;
      else logger.warn({ mint: c.mint, reason: sq.reason }, 'post_entry_sell_quote_failed');
    } catch (e) {
      logger.warn({ mint: c.mint, err: e }, 'post_entry_sell_quote_failed');
    }
    const sellCost = sideCostFraction({
      swapFeeBps: config.costs.swapFeeBps,
      slippageBps: config.costs.expectedSlippageBps,
      priceImpact: sellImpact,
      priorityFeeLamports: BigInt(config.costs.priorityFeeLamports),
      sizeLamports: buy.inFilled,
    });

    const s = config.strategy;
    const gross = grossMultiplier(Math.min(buyCost, 0.99), Math.min(sellCost, 0.99), s.targetNetMultiplier);
    const now = clock.now();
    const { positionId } = storage.openPosition(
      {
        mint: c.mint,
        symbol: c.symbol,
        mode: executor.mode,
        tokenDecimals: opts.tokenDecimals,
        tokenAmountRaw: buy.out,
        costBasisLamports: costBasis,
        entrySolUsd: solUsd,
        entryMcapUsd: c.marketCapUsd,
        buyCostFraction: buyCost,
        sellCostFraction: sellCost,
        tpGrossMultiplier: gross,
        tpTargetNetLamports: takeProfitTarget(costBasis, s.targetNetMultiplier),
        enteredAt: now,
        timeStopAt: now + s.timeStopHours * HOUR_MS,
        stopLossFraction: s.stopLoss.lossFraction,
      },
      { ...tradeBase, status: 'filled' },
    );
    logger.info(
      {
        positionId,
        mint: c.mint,
        symbol: c.symbol,
        costBasis,
        tokens: buy.out,
        buyCost,
        sellCost,
        tpGrossMultiplier: gross,
        stopLossAt: stopLossThreshold(costBasis, s.stopLoss.lossFraction),
      },
      'position_opened',
    );
    return { entered: true, positionId, costBasisLamports: costBasis, tpGrossMultiplier: gross };
  }

  exit(position: Position, reason: ExitReason, solUsd: number | null): Promise<SellOutcome> {
    const { executor, storage, config, clock, logger, sleep } = this.deps;
    return sellWithRetry(position, reason, { executor, storage, config, clock, logger, solUsd, ...(sleep ? { sleep } : {}) });
  }
}
