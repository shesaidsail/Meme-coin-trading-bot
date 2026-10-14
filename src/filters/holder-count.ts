import { type Filter, pass, fail, missing } from './types.js';

export const holderCountFilter: Filter = {
  name: 'holderCount',
  async check(ctx) {
    const min = ctx.config.filters.holderCount.minHolders;
    const r = await ctx.rugcheck();
    if (!r.ok) return missing(`holder count unavailable: ${r.reason}`);
    const n = r.value.totalHolders;
    if (n === null || n === undefined) return missing('RugCheck report has no holder count');
    const data = { holders: n, source: 'rugcheck' };
    return n < min ? fail(`${n} holders < ${min}`, data) : pass(`${n} holders`, data);
  },
};
