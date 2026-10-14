import { type Filter, pass, fail, missing, pct } from './types.js';

/**
 * Top-10 and single-wallet concentration, excluding pool accounts, AMM
 * authorities and burn addresses. Holders are aggregated by owner wallet.
 */
export const holderConcentrationFilter: Filter = {
  name: 'holderConcentration',
  async check(ctx) {
    const cfg = ctx.config.filters.holderConcentration;
    const h = await ctx.holders();
    if (!h.ok) return missing(h.reason);
    const excluded = await ctx.excludedOwners();
    const real = h.value.filter((x) => !excluded.has(x.owner) && !x.accounts.some((a) => excluded.has(a)));
    const top10 = real.slice(0, 10);
    const top10Fraction = top10.reduce((s, x) => s + x.fraction, 0);
    const largest = top10[0];
    const data = {
      source: h.source,
      excludedCount: h.value.length - real.length,
      top10Fraction,
      largest: largest ? { owner: largest.owner, fraction: largest.fraction } : null,
    };
    if (largest && largest.fraction > cfg.maxSingleWalletFraction) {
      return fail(`wallet ${largest.owner} holds ${pct(largest.fraction)} (> ${pct(cfg.maxSingleWalletFraction)})`, data);
    }
    if (top10Fraction > cfg.maxTop10Fraction) {
      return fail(`top 10 holders own ${pct(top10Fraction)} (> ${pct(cfg.maxTop10Fraction)})`, data);
    }
    return pass(`top 10 ${pct(top10Fraction)}, largest ${pct(largest?.fraction ?? 0)} (${h.source})`, data);
  },
};
