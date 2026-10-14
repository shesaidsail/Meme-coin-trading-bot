import { ratio } from '../util/units.js';
import { type Filter, pass, fail, missing, pct } from './types.js';

/**
 * Sell simulation via Jupiter quotes sized like our entry: quote the buy,
 * then quote selling what the buy returns. Rejects if either leg has no
 * route, if the sell's price impact is too high, or if the round trip
 * loses too much (sell taxes and asymmetric pools show up here).
 */
export const honeypotFilter: Filter = {
  name: 'honeypot',
  async check(ctx) {
    const cfg = ctx.config.filters.honeypot;
    const q = await ctx.honeypotQuotes();
    if (!q.ok) return missing(`quotes unavailable: ${q.reason}`);
    const { buy, sell, sizeLamports } = q.value;
    if (!buy.ok) return fail(`no buy route (${buy.reason}: ${buy.message})`);
    if (!sell || !sell.ok) return fail(`sell quote failed${sell ? ` (${sell.reason}: ${sell.message})` : ''}; possible honeypot`);

    const roundTripLoss = 1 - ratio(sell.quote.outAmount, sizeLamports);
    const data = {
      sizeLamports: sizeLamports.toString(),
      buyImpact: buy.quote.priceImpact,
      sellImpact: sell.quote.priceImpact,
      roundTripLoss,
      sellRoute: sell.quote.routeLabels,
    };
    if (sell.quote.priceImpact > cfg.maxSellPriceImpact) {
      return fail(`sell price impact ${pct(sell.quote.priceImpact)} > ${pct(cfg.maxSellPriceImpact)}`, data);
    }
    if (roundTripLoss > cfg.maxRoundTripLoss) {
      return fail(`round-trip loss ${pct(roundTripLoss)} > ${pct(cfg.maxRoundTripLoss)}`, data);
    }
    return pass(`round trip ${pct(-roundTripLoss)}, sell impact ${pct(sell.quote.priceImpact)}`, data);
  },
};
