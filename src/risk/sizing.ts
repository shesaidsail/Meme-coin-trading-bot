import type { Config } from '../config/schema.js';
import { mulFrac } from '../util/units.js';
import type { Equity } from './equity.js';

/** Total SOL committed to a new entry (swap + fees + token-account rent): a fixed fraction of current equity. */
export function entrySizeLamports(equityLamports: bigint, cfg: Config['strategy']): bigint {
  return mulFrac(equityLamports, cfg.positionSizeFraction);
}

export type EntryCheck =
  | { ok: true; sizeLamports: bigint; swapLamports: bigint }
  | { ok: false; reason: 'max_open_positions' | 'max_deployed' | 'insufficient_cash' | 'size_too_small'; detail: string };

/**
 * Applies the exposure caps. Both caps are hard: if either would be
 * exceeded the entry is skipped (never downsized).
 *  - open positions < maxOpenPositions
 *  - deployed + new entry ≤ maxDeployedFraction × equity
 *  - the entry is affordable from cash
 */
export function checkEntry(equity: Equity, config: Config): EntryCheck {
  const s = config.strategy;
  const size = entrySizeLamports(equity.equityLamports, s);
  const fees = BigInt(config.costs.priorityFeeLamports) + BigInt(config.costs.ataRentLamports);
  const swap = size - fees;
  if (equity.openPositions >= s.maxOpenPositions) {
    return { ok: false, reason: 'max_open_positions', detail: `${equity.openPositions} open (max ${s.maxOpenPositions})` };
  }
  const cap = mulFrac(equity.equityLamports, s.maxDeployedFraction);
  if (equity.deployedLamports + size > cap) {
    return {
      ok: false,
      reason: 'max_deployed',
      detail: `deployed ${equity.deployedLamports} + entry ${size} > cap ${cap} lamports`,
    };
  }
  if (swap <= 0n) return { ok: false, reason: 'size_too_small', detail: `entry ${size} does not cover fees ${fees}` };
  if (size > equity.cashLamports) {
    return { ok: false, reason: 'insufficient_cash', detail: `entry ${size} > cash ${equity.cashLamports}` };
  }
  return { ok: true, sizeLamports: size, swapLamports: swap };
}
