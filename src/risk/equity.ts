import type { Config } from '../config/schema.js';
import type { JupiterClient } from '../clients/jupiter.js';
import { BudgetExhaustedError } from '../clients/errors.js';
import type { Storage } from '../storage/store.js';
import type { Position } from '../storage/types.js';
import type { Clock } from '../util/clock.js';
import type { Logger } from '../util/logger.js';
import type { Quote } from '../clients/jupiter.js';
import { netFromSellQuote } from './exit-math.js';

export type Valuation =
  | { ok: true; positionId: number; quote: Quote; netLamports: bigint }
  | { ok: false; positionId: number; reason: string; consecutiveFailures: number; unquotable: boolean };

export interface Equity {
  cashLamports: bigint;
  /** Sum of sellable (net of sell costs) values; unquotable positions count as 0. */
  positionsLamports: bigint;
  equityLamports: bigint;
  /**
   * Capital counted against the exposure cap: sellable value, or cost
   * basis when a position could not be quoted (conservative both ways:
   * it adds nothing to equity but still uses up exposure).
   */
  deployedLamports: bigint;
  openPositions: number;
  unquotablePositions: number;
}

/**
 * Quotes a full sell of every open position (priority "critical", so it can
 * use the budget reserve) and records the result: success resets the
 * failure streak; failure increments it and flags the position unquotable
 * after `unquotableAfterFailures` consecutive failures.
 */
export async function valuePositions(
  positions: Position[],
  deps: { jupiter: Pick<JupiterClient, 'quote'>; storage: Storage; config: Config; clock: Clock; logger: Logger },
): Promise<Map<number, Valuation>> {
  const { config, storage, clock, logger } = deps;
  const out = new Map<number, Valuation>();
  for (const p of positions) {
    if (p.tokenAmountRaw <= 0n) continue;
    let reason: string;
    try {
      const r = await deps.jupiter.quote({
        inputMint: p.mint,
        outputMint: config.chain.solMint,
        amount: p.tokenAmountRaw,
        slippageBps: config.execution.sell.initialSlippageBps,
        priority: 'critical',
      });
      if (r.ok) {
        const net = netFromSellQuote(r.quote.outAmount, config.costs);
        storage.positions.recordQuote(p.id, net, clock.now());
        out.set(p.id, { ok: true, positionId: p.id, quote: r.quote, netLamports: net });
        continue;
      }
      reason = `${r.reason}: ${r.message}`;
    } catch (e) {
      reason = e instanceof BudgetExhaustedError ? `budget: ${e.message}` : e instanceof Error ? e.message : String(e);
    }
    const updated = storage.positions.recordQuoteFailure(p.id, clock.now(), config.strategy.unquotableAfterFailures);
    const unquotable = updated.unquotableSince !== null;
    if (unquotable && updated.consecutiveQuoteFailures === config.strategy.unquotableAfterFailures) {
      storage.audit.log('position_unquotable', clock.now(), { level: 'warn', mint: p.mint, positionId: p.id, data: { reason } });
      logger.warn({ positionId: p.id, mint: p.mint, reason }, 'position_unquotable');
    }
    out.set(p.id, { ok: false, positionId: p.id, reason, consecutiveFailures: updated.consecutiveQuoteFailures, unquotable });
  }
  return out;
}

export function computeEquity(cashLamports: bigint, positions: Position[], valuations: Map<number, Valuation>): Equity {
  let value = 0n;
  let deployed = 0n;
  let unquotable = 0;
  for (const p of positions) {
    const v = valuations.get(p.id);
    if (v?.ok) {
      value += v.netLamports;
      deployed += v.netLamports;
    } else {
      deployed += p.costBasisLamports;
      if (p.unquotableSince !== null || (v && !v.ok && v.unquotable)) unquotable++;
    }
  }
  return {
    cashLamports,
    positionsLamports: value,
    equityLamports: cashLamports + value,
    deployedLamports: deployed,
    openPositions: positions.length,
    unquotablePositions: unquotable,
  };
}
