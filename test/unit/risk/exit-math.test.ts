import { describe, it, expect } from 'vitest';
import { grossMultiplier, netFromSellQuote, sideCostFraction, takeProfitTarget, stopLossThreshold } from '../../../src/risk/exit-math.js';
import { testConfig } from '../../helpers/deps.js';
import { solToLamports } from '../../../src/util/units.js';

describe('exit multiplier', () => {
  it('matches the spec example: 3% cost each side → ≈2.66x gross for +150% net', () => {
    expect(grossMultiplier(0.03, 0.03, 2.5)).toBeCloseTo(2.657, 3);
  });

  it('is exactly the target with zero costs', () => {
    expect(grossMultiplier(0, 0, 2.5)).toBe(2.5);
  });

  it('delivers exactly the target net multiple after both sides of costs', () => {
    for (const [b, s] of [
      [0.01, 0.02],
      [0.05, 0.08],
      [0.1, 0.15],
    ] as const) {
      const spent = 1;
      const g = grossMultiplier(b, s, 2.5);
      const net = spent * (1 - b) * g * (1 - s);
      expect(net).toBeCloseTo(2.5, 10);
    }
  });

  it('rejects impossible costs', () => {
    expect(() => grossMultiplier(1, 0, 2.5)).toThrow(RangeError);
    expect(() => grossMultiplier(0, -0.1, 2.5)).toThrow(RangeError);
  });

  it('sums the cost components of one side', () => {
    const c = sideCostFraction({ swapFeeBps: 10, slippageBps: 100, priceImpact: 0.02, priorityFeeLamports: 100_000n, sizeLamports: solToLamports(0.5) });
    expect(c).toBeCloseTo(0.001 + 0.01 + 0.02 + 0.0002, 10);
  });
});

describe('take-profit on the sell quote', () => {
  const costs = testConfig().costs; // 0 fee, 100bps expected slippage, 100k lamports priority

  it('nets the remaining sell costs out of the quote', () => {
    expect(netFromSellQuote(solToLamports(2), costs)).toBe(solToLamports(2) - solToLamports(0.02) - 100_000n);
    expect(netFromSellQuote(1_000n, costs)).toBe(0n);
  });

  it('target is 2.5 × cost basis; the trigger needs a quote that clears it after costs', () => {
    const basis = solToLamports(0.5);
    const target = takeProfitTarget(basis, 2.5);
    expect(target).toBe(solToLamports(1.25));
    // A quote of exactly 1.25 SOL is NOT enough once sell costs are deducted.
    expect(netFromSellQuote(solToLamports(1.25), costs) >= target).toBe(false);
    // Needed quote: (1.25 + priority) / (1 - 1%)
    const needed = solToLamports((1.25 + 0.0001) / 0.99) + 1n;
    expect(netFromSellQuote(needed, costs) >= target).toBe(true);
  });

  it('stop-loss threshold is cost basis × (1 - loss)', () => {
    expect(stopLossThreshold(solToLamports(1), 0.5)).toBe(solToLamports(0.5));
  });
});
