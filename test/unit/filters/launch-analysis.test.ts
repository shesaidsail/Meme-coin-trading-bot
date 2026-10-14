import { describe, it, expect } from 'vitest';
import { analyzeLaunch } from '../../../src/filters/launch-analysis.js';
import { ABU_MINT } from '../../helpers/filter-ctx.js';
import { launchTxs, SUPPLY, part } from './launch.fixtures.js';

describe('analyzeLaunch', () => {
  const { txs } = launchTxs('Dev');
  const all = Object.values(txs);

  it('counts creator and sniper buys in the window, not the bonding curve or later buyers', () => {
    const a = analyzeLaunch(all, ABU_MINT, SUPPLY, new Set(), 2, false)!;
    expect(a.firstSlot).toBe(100);
    expect(a.txCount).toBe(3);
    expect(a.boughtByOwner.get('Dev')).toBe(part(0.04));
    expect(a.boughtByOwner.get('S1')).toBe(part(0.1));
    expect(a.boughtByOwner.has('Curve')).toBe(false);
    expect(a.boughtByOwner.has('L')).toBe(false);
    expect(a.launchBuyFraction).toBeCloseTo(0.22, 4);
    expect(a.buyerCount).toBe(3);
  });

  it('respects the window size and excluded owners', () => {
    expect(analyzeLaunch(all, ABU_MINT, SUPPLY, new Set(), 1, false)!.launchBuyFraction).toBeCloseTo(0.04, 4);
    expect(analyzeLaunch(all, ABU_MINT, SUPPLY, new Set(['S1', 'S2']), 2, false)!.launchBuyFraction).toBeCloseTo(0.04, 4);
  });

  it('ignores failed transactions and returns null when nothing is usable', () => {
    expect(analyzeLaunch(all.map((t) => ({ ...t, failed: true })), ABU_MINT, SUPPLY, new Set(), 2, false)).toBeNull();
  });
});
