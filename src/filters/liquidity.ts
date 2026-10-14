import { type Filter, pass, fail, missing, pct, usd } from './types.js';

/** Minimum liquidity (primary pool) and liquidity / market cap ratio. Uses scanner (DexScreener) data only. */
export const liquidityFilter: Filter = {
  name: 'liquidity',
  async check(ctx) {
    const cfg = ctx.config.filters.liquidity;
    const liq = ctx.candidate.primaryPair.liquidityUsd;
    const mcap = ctx.candidate.marketCapUsd;
    if (liq === null || !Number.isFinite(liq)) return missing('no liquidity figure for primary pair');
    if (!(mcap > 0)) return missing('no market cap');
    const ratio = liq / mcap;
    const data = { liquidityUsd: liq, marketCapUsd: mcap, ratio, dexId: ctx.candidate.primaryPair.dexId };
    if (liq < cfg.minLiquidityUsd) return fail(`liquidity ${usd(liq)} < ${usd(cfg.minLiquidityUsd)}`, data);
    if (ratio < cfg.minLiquidityToMcap) return fail(`liquidity/mcap ${pct(ratio)} < ${pct(cfg.minLiquidityToMcap)}`, data);
    return pass(`liquidity ${usd(liq)}, ${pct(ratio)} of mcap`, data);
  },
};
