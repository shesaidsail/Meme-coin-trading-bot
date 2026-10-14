import { type Filter, pass, fail, missing, pct } from './types.js';

/**
 * Bundled / sniped launch detection from independent signals:
 *  - on-chain: share of supply bought in the first N slots by non-pool
 *    wallets (bounded history walk; busy tokens are unavailable);
 *  - RugCheck insider-held: share currently held by top holders flagged insider;
 *  - RugCheck linked network: the largest network of linked wallets, by the
 *    token amount RugCheck attributes to it (see maxLinkedNetworkFraction).
 * Any available signal over its threshold rejects. If none is available the
 * result is missing data.
 */
export const bundledLaunchFilter: Filter = {
  name: 'bundledLaunch',
  async check(ctx) {
    const cfg = ctx.config.filters.bundledLaunch;
    const data: Record<string, unknown> = {};
    let evaluated = 0;
    const parts: string[] = [];

    const supply = await ctx.supply();
    const r = await ctx.rugcheck();
    if (r.ok && supply.ok && supply.value > 0n) {
      const sup = Number(supply.value);
      const held = (r.value.topHolders ?? []).filter((h) => h.insider).reduce((s, h) => s + h.pct / 100, 0);
      const networks = r.value.insiderNetworks ?? [];
      const largest = networks.reduce<(typeof networks)[number] | null>(
        (best, n) => ((n.tokenAmount ?? 0) > (best?.tokenAmount ?? -1) ? n : best),
        null,
      );
      const linked = largest ? (largest.tokenAmount ?? 0) / sup : 0;
      Object.assign(data, {
        insiderHeldFraction: held,
        linkedNetworkFraction: linked,
        linkedNetworkWallets: largest?.size ?? 0,
        networks: networks.length,
      });
      data.source = 'rugcheck';
      evaluated++;
      if (held > cfg.maxInsiderHeldFraction) {
        return fail(`insider-flagged holders hold ${pct(held)} (> ${pct(cfg.maxInsiderHeldFraction)}, RugCheck)`, data);
      }
      if (linked > cfg.maxLinkedNetworkFraction) {
        return fail(
          `${pct(linked)} of supply moved through a network of ${largest?.size ?? '?'} linked wallets (> ${pct(cfg.maxLinkedNetworkFraction)}, RugCheck)`,
          data,
        );
      }
      parts.push(`insiders hold ${pct(held)}`, `linked network ${pct(linked)}`);
    } else {
      data.rugcheck = r.ok ? 'no supply' : r.reason;
    }

    const launch = await ctx.launch();
    if (launch.ok) {
      const a = launch.value;
      Object.assign(data, {
        launchBuyFraction: a.launchBuyFraction,
        launchBuyers: a.buyerCount,
        launchTxs: a.txCount,
        truncated: a.truncated,
      });
      data.source = data.source ? 'rugcheck+onchain' : 'onchain';
      evaluated++;
      if (a.launchBuyFraction > cfg.maxLaunchBuyFraction) {
        return fail(
          `${pct(a.launchBuyFraction)} of supply bought in first ${cfg.launchSlots} slot(s) by ${a.buyerCount} wallet(s) (> ${pct(cfg.maxLaunchBuyFraction)})`,
          data,
        );
      }
      parts.push(`launch buys ${pct(a.launchBuyFraction)}${a.truncated ? ' (lower bound)' : ''}`);
    } else {
      data.onchain = launch.reason;
    }

    if (!evaluated) {
      return missing(`no launch or insider data (on-chain: ${launch.ok ? 'n/a' : launch.reason}; RugCheck: ${r.ok ? 'no supply' : r.reason})`, data);
    }
    return pass(parts.join(', '), data);
  },
};
