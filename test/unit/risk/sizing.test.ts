import { describe, it, expect } from 'vitest';
import { checkEntry, entrySizeLamports } from '../../../src/risk/sizing.js';
import type { Equity } from '../../../src/risk/equity.js';
import { testConfig } from '../../helpers/deps.js';
import { solToLamports } from '../../../src/util/units.js';

const config = testConfig();
const eq = (over: Partial<Equity> = {}): Equity => ({
  cashLamports: solToLamports(10),
  positionsLamports: 0n,
  equityLamports: solToLamports(10),
  deployedLamports: 0n,
  openPositions: 0,
  unquotablePositions: 0,
  ...over,
});

describe('position sizing', () => {
  it('is 5% of current equity', () => {
    expect(entrySizeLamports(solToLamports(10), config.strategy)).toBe(solToLamports(0.5));
    expect(entrySizeLamports(solToLamports(13), config.strategy)).toBe(solToLamports(0.65));
  });

  it('uses equity at sellable value, so it grows and shrinks with marked positions', () => {
    const grown = eq({ cashLamports: solToLamports(8), positionsLamports: solToLamports(4), equityLamports: solToLamports(12), deployedLamports: solToLamports(4), openPositions: 2 });
    const r = checkEntry(grown, config);
    expect(r).toMatchObject({ ok: true, sizeLamports: solToLamports(0.6) });
  });

  it('the swap amount leaves room for priority fee and token-account rent', () => {
    const r = checkEntry(eq(), config);
    if (!r.ok) throw new Error(r.detail);
    expect(r.sizeLamports - r.swapLamports).toBe(BigInt(config.costs.priorityFeeLamports + config.costs.ataRentLamports));
  });
});

describe('exposure caps', () => {
  it('skips the 11th position', () => {
    expect(checkEntry(eq({ openPositions: 9 }), config).ok).toBe(true);
    expect(checkEntry(eq({ openPositions: 10 }), config)).toMatchObject({ ok: false, reason: 'max_open_positions' });
  });

  it('allows deploying exactly up to 50% of equity, never beyond', () => {
    // 45% deployed + 5% entry = exactly 50%: allowed.
    expect(checkEntry(eq({ deployedLamports: solToLamports(4.5) }), config).ok).toBe(true);
    // One lamport more: skipped.
    expect(checkEntry(eq({ deployedLamports: solToLamports(4.5) + 1n }), config)).toMatchObject({ ok: false, reason: 'max_deployed' });
  });

  it('skips rather than downsizing when a cap would be exceeded', () => {
    const r = checkEntry(eq({ deployedLamports: solToLamports(4.8) }), config);
    expect(r.ok).toBe(false);
  });

  it('skips when cash cannot cover the entry', () => {
    const r = checkEntry(eq({ cashLamports: solToLamports(0.2), positionsLamports: solToLamports(4.8), equityLamports: solToLamports(5), deployedLamports: 0n }), config);
    expect(r).toMatchObject({ ok: false, reason: 'insufficient_cash' });
  });

  it('respects configured limits', () => {
    const c = testConfig({ strategy: { maxOpenPositions: 2, maxDeployedFraction: 0.2, positionSizeFraction: 0.1 } });
    expect(checkEntry(eq({ openPositions: 2 }), c).ok).toBe(false);
    expect(checkEntry(eq({ deployedLamports: solToLamports(1.1) }), c).ok).toBe(false);
    expect(checkEntry(eq({ deployedLamports: solToLamports(1) }), c).ok).toBe(true);
  });
});
