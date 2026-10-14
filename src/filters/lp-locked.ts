import { TokenContext } from './context.js';
import { type Filter, pass, fail, missing, pct } from './types.js';

/**
 * LP of the primary pool must be burned or locked. The primary pool is the
 * DexScreener pair with the most liquidity, matched to RugCheck's market
 * data. For pools with an LP mint, an LP supply of zero on-chain verifies a
 * full burn; otherwise RugCheck's locked/burned percentage is used.
 * Position-based pools (Meteora DLMM, Raydium CLMM, ...) have no LP mint;
 * unless RugCheck reports their positions locked, they fail.
 */
export const lpLockedFilter: Filter = {
  name: 'lpLocked',
  async check(ctx) {
    const min = ctx.config.filters.lpLocked.minBurnedOrLockedFraction;
    const r = await ctx.rugcheck();
    if (!r.ok) return missing(`no LP data: ${r.reason}`);
    const markets = r.value.markets ?? [];
    if (!markets.length) return missing('RugCheck lists no markets');

    const primary =
      markets.find((m) => m.pubkey === ctx.candidate.primaryPair.address) ??
      [...markets].sort((a, b) => (b.lp?.quoteUSD ?? 0) + (b.lp?.baseUSD ?? 0) - ((a.lp?.quoteUSD ?? 0) + (a.lp?.baseUSD ?? 0)))[0]!;
    const matched = primary.pubkey === ctx.candidate.primaryPair.address;
    const rcFraction = (primary.lp?.lpLockedPct ?? 0) / 100;
    const data: Record<string, unknown> = {
      pool: primary.pubkey,
      marketType: primary.marketType,
      matchedDexScreenerPair: matched,
      rugcheckLockedFraction: rcFraction,
    };

    if (TokenContext.hasRealLpMint(primary.mintLP)) {
      data.lpMint = primary.mintLP;
      const s = await ctx.lpSupply(primary.mintLP);
      if (s.ok) {
        data.onchainLpSupply = s.value.toString();
        if (s.value === 0n) return pass('LP fully burned (LP supply 0, verified on-chain)', { ...data, source: 'onchain' });
      } else {
        data.onchainError = s.reason;
      }
      if (rcFraction >= min) return pass(`LP ${pct(rcFraction)} burned/locked (RugCheck)`, { ...data, source: 'rugcheck' });
      return fail(`LP only ${pct(rcFraction)} burned/locked (< ${pct(min)})`, { ...data, source: 'rugcheck' });
    }

    if (rcFraction >= min) return pass(`${primary.marketType} positions ${pct(rcFraction)} locked (RugCheck)`, { ...data, source: 'rugcheck' });
    return fail(`primary pool is ${primary.marketType} (position-based, no LP to burn; ${pct(rcFraction)} locked)`, { ...data, source: 'rugcheck' });
  },
};
