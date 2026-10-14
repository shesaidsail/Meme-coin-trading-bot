import { describe, it, expect } from 'vitest';
import { Scanner, buildCandidate } from '../../src/scanner/scanner.js';
import type { DexPair } from '../../src/clients/dexscreener.js';
import { makeDeps, testConfig } from '../helpers/deps.js';
import { fixture, SOL } from '../helpers/filter-ctx.js';

const pairs = fixture<DexPair[]>('dexscreener-tokens.json');
const bySymbol = (s: string) => pairs.filter((p) => p.baseToken.symbol === s);
const mintOf = (s: string) => bySymbol(s)[0]!.baseToken.address;

function pair(mint: string, over: Partial<DexPair> = {}): DexPair {
  return {
    chainId: 'solana',
    dexId: 'pumpswap',
    pairAddress: `pool-${mint}`,
    baseToken: { address: mint, symbol: mint.slice(0, 4), name: mint },
    quoteToken: { address: SOL, symbol: 'SOL' },
    liquidity: { usd: 50_000 },
    marketCap: 300_000,
    pairCreatedAt: Date.parse('2026-10-14T00:00:00Z'),
    ...over,
  } as DexPair;
}

describe('buildCandidate', () => {
  const config = testConfig();

  it('builds from real pairs', () => {
    const c = buildCandidate(mintOf('ABU'), bySymbol('ABU'), config, ['x']);
    expect(c).toMatchObject({ symbol: 'ABU', primaryPair: { dexId: 'pumpswap' } });
  });

  it('skips bonding-curve-only tokens (real pumpfun pairs)', () => {
    expect(buildCandidate(mintOf('PUNK'), bySymbol('PUNK'), config, [])).toBe('only on excluded dex (pumpfun)');
  });

  it('picks the most liquid SOL/USDC pair as primary and keeps every pool address', () => {
    const m = 'MintX';
    const c = buildCandidate(
      m,
      [
        pair(m, { pairAddress: 'small', liquidity: { usd: 5_000 } }),
        pair(m, { pairAddress: 'big', dexId: 'raydium', liquidity: { usd: 80_000 }, pairCreatedAt: 1 }),
        pair(m, { pairAddress: 'other-quote', quoteToken: { address: 'BONK', symbol: 'BONK' }, liquidity: { usd: 999_999 } }),
      ],
      config,
      [],
    );
    if (typeof c === 'string') throw new Error(c);
    expect(c.primaryPair.address).toBe('big');
    expect(c.totalLiquidityUsd).toBe(85_000);
    expect(c.pairAddresses.sort()).toEqual(['big', 'other-quote', 'small']);
    expect(c.earliestPairCreatedAt).toBe(1);
  });

  it('reports why a mint is unusable', () => {
    expect(buildCandidate('m', [], config, [])).toBe('no DexScreener pairs');
    expect(buildCandidate('m', [pair('m', { quoteToken: { address: 'X', symbol: 'X' } })], config, [])).toBe('no SOL/USDC pair');
    expect(buildCandidate('m', [pair('m', { marketCap: null, fdv: null })], config, [])).toBe('no market cap');
  });
});

describe('Scanner.scan', () => {
  function setup(feedMints: string[], pairList: DexPair[]) {
    const d = makeDeps();
    d.fake
      .on(/token-profiles\/latest/, { body: feedMints.map((m) => ({ chainId: 'solana', tokenAddress: m })) })
      .on(/token-profiles\/recent-updates|community-takeovers|ads\/latest|token-boosts/, { body: [{ chainId: 'bsc', tokenAddress: 'evm' }] })
      .on(/stats\/new_tokens/, { body: [{ mint: 'young' }] })
      .on(/stats\/recent/, { status: 500 })
      .on(/stats\/trending/, { body: null })
      .on(/tokens\/v1\/solana/, (url) => {
        const asked = new Set(url.pathname.split('/').pop()!.split(','));
        return { body: pairList.filter((p) => asked.has(p.baseToken.address)) };
      });
    const scanner = new Scanner({ config: d.config, clients: d.clients, storage: d.storage, clock: d.clock, logger: d.logger });
    return { ...d, scanner };
  }

  it('discovers, prices, bands and ranks candidates closest to the target market cap', async () => {
    const list = [
      pair('A', { marketCap: 590_000 }),
      pair('B', { marketCap: 310_000 }),
      pair('C', { marketCap: 100_000 }), // below band
      pair('D', { marketCap: 200_000 }),
      pair('E', { dexId: 'pumpfun', marketCap: 300_000 }),
    ];
    const { scanner, storage } = setup(['A', 'B', 'C', 'D', 'E'], list);
    const s = await scanner.scan();
    expect(s.candidates.map((c) => c.mint)).toEqual(['B', 'D', 'A']);
    expect(s.dropped).toMatchObject({ 'outside market cap band': 1, 'only on excluded dex (pumpfun)': 1, 'no DexScreener pairs': 1 });
    expect(s.discovered).toMatchObject({ dexscreenerProfiles: 5, rugcheckNewTokens: 1, rugcheckTrending: 0, dexscreenerBoosts: 0 });
    // A failing source is recorded, not fatal.
    expect(s.sourceErrors.rugcheckRecent).toMatch(/HTTP 500/);
    expect(storage.watchlist.count()).toBe(6);
  });

  it('respects the recheck cooldown and re-prices once it has passed', async () => {
    const { scanner, clock, fake } = setup(['A'], [pair('A')]);
    await scanner.scan();
    const priced = () => fake.count(/tokens\/v1\/solana/);
    expect(priced()).toBe(1);
    await scanner.scan();
    expect(priced()).toBe(1);
    clock.advance(10 * 60_000);
    await scanner.scan();
    expect(priced()).toBe(2);
  });

  it('skips recently evaluated mints and open positions', async () => {
    const { scanner, storage, clock } = setup(['A', 'B'], [pair('A'), pair('B')]);
    storage.audit.recordEvaluation(
      { scanId: 's', mint: 'A', symbol: null, mcapUsd: 1, liquidityUsd: 1, verdict: 'rejected', rejectedBy: ['x'], decision: null, results: [] },
      clock.now(),
    );
    const s = await scanner.scan();
    expect(s.candidates.map((c) => c.mint)).toEqual(['B']);
    expect(s.dropped['evaluated recently']).toBe(1);
  });
});
