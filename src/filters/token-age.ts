import { type Filter, pass, fail, missing } from './types.js';

/**
 * Minimum token age. Creation time is approximated by the earliest of the
 * pair creation times and RugCheck's first detection, all of which are at
 * or after true creation. RugCheck is only consulted if pair age alone is
 * too young (e.g. a token that recently migrated to a new pool).
 */
export const tokenAgeFilter: Filter = {
  name: 'tokenAge',
  async check(ctx) {
    const minMs = ctx.config.filters.tokenAge.minAgeMinutes * 60_000;
    const now = ctx.now();
    const times: number[] = [];
    if (ctx.candidate.earliestPairCreatedAt) times.push(ctx.candidate.earliestPairCreatedAt);
    if (!times.length || now - Math.min(...times) < minMs) {
      const r = await ctx.rugcheck();
      if (r.ok && r.value.detectedAt) {
        const t = Date.parse(r.value.detectedAt);
        if (!Number.isNaN(t)) times.push(t);
      }
    }
    if (!times.length) return missing('no creation timestamp from DexScreener or RugCheck');
    const ageMin = (now - Math.min(...times)) / 60_000;
    const data = { ageMinutes: Math.round(ageMin) };
    if (ageMin * 60_000 < minMs) {
      return fail(`age ${Math.round(ageMin)}m < ${ctx.config.filters.tokenAge.minAgeMinutes}m`, data);
    }
    return pass(`age ${Math.round(ageMin)}m`, data);
  },
};
