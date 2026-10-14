import type { Config } from '../config/schema.js';
import { bpsToFraction, mulFrac, ratio } from '../util/units.js';

/**
 * Cost of one side of a round trip, as a fraction of the SOL amount:
 * platform fee + expected slippage + quoted price impact + priority fee.
 */
export function sideCostFraction(i: {
  swapFeeBps: number;
  slippageBps: number;
  priceImpact: number;
  priorityFeeLamports: bigint;
  sizeLamports: bigint;
}): number {
  if (i.sizeLamports <= 0n) throw new RangeError('size must be positive');
  return bpsToFraction(i.swapFeeBps) + bpsToFraction(i.slippageBps) + Math.max(0, i.priceImpact) + ratio(i.priorityFeeLamports, i.sizeLamports);
}

/**
 * Price multiple needed for a net multiple of `targetNet` after costs:
 *   gross = targetNet / ((1 - buyCost) * (1 - sellCost))
 * e.g. 3% each side, target 2.5 → ≈ 2.657 (+166%).
 */
export function grossMultiplier(buyCost: number, sellCost: number, targetNet: number): number {
  if (!(buyCost >= 0 && buyCost < 1 && sellCost >= 0 && sellCost < 1)) {
    throw new RangeError(`costs must be in [0, 1): buy ${buyCost}, sell ${sellCost}`);
  }
  return targetNet / ((1 - buyCost) * (1 - sellCost));
}

/** Net SOL a position would realise if sold now at this quote, after the remaining sell-side costs. */
export function netFromSellQuote(quoteOutLamports: bigint, costs: Config['costs']): bigint {
  const afterSlippage = mulFrac(quoteOutLamports, 1 - bpsToFraction(costs.swapFeeBps + costs.expectedSlippageBps));
  const net = afterSlippage - BigInt(costs.priorityFeeLamports);
  return net > 0n ? net : 0n;
}

/** Net proceeds at which take-profit fires: targetNet × cost basis. */
export function takeProfitTarget(costBasisLamports: bigint, targetNet: number): bigint {
  return mulFrac(costBasisLamports, targetNet);
}

/** Net value at or below which the (possibly shadow) stop-loss fires. */
export function stopLossThreshold(costBasisLamports: bigint, lossFraction: number): bigint {
  return mulFrac(costBasisLamports, 1 - lossFraction);
}
