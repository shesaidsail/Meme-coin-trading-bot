import { type Filter, pass, fail, missing, pct } from './types.js';

/**
 * Creator wallet checks. Holding is required data (missing → policy).
 * Prior rugs and heavy selling are checked when the data exists and are
 * otherwise recorded as unknown, not treated as missing.
 */
export const devWalletFilter: Filter = {
  name: 'devWallet',
  async check(ctx) {
    const cfg = ctx.config.filters.devWallet;
    const r = await ctx.rugcheck();
    if (!r.ok) return missing(`creator unknown: ${r.reason}`);
    const creator = r.value.creator;
    if (!creator) return missing('RugCheck report has no creator');
    const supply = await ctx.supply();
    if (!supply.ok) return missing(supply.reason);
    const balance = BigInt(Math.round(r.value.creatorBalance ?? 0));
    const holding = supply.value > 0n ? Number((balance * 1_000_000n) / supply.value) / 1_000_000 : 0;

    const data: Record<string, unknown> = { creator, holdingFraction: holding };
    if (holding > cfg.maxDevHoldingFraction) {
      return fail(`creator holds ${pct(holding)} (> ${pct(cfg.maxDevHoldingFraction)})`, data);
    }

    // Prior rugs: RugCheck risk entries about the creator's history, and the creator's other tokens.
    const rugRisks = (r.value.risks ?? []).filter((x) => /creator|deployer|dev/i.test(x.name) && /rug/i.test(x.name));
    data.creatorOtherTokens = r.value.creatorTokens?.length ?? null;
    data.priorRugRisks = rugRisks.map((x) => x.name);
    if (cfg.rejectPriorRugs && rugRisks.length) return fail(`creator flagged: ${rugRisks.map((x) => x.name).join('; ')}`, data);

    // Selling: only knowable when the on-chain launch analysis saw the creator's initial buy.
    // Uses the already-memoised analysis if the bundle filter ran; otherwise fetches it.
    const launch = await ctx.launch();
    const launchBought = launch.ok ? launch.value.boughtByOwner.get(creator) : undefined;
    if (launchBought && launchBought > 0n) {
      const sold = balance >= launchBought ? 0 : 1 - Number((balance * 1_000_000n) / launchBought) / 1_000_000;
      data.soldFraction = sold;
      if (sold > cfg.maxDevSoldFraction) return fail(`creator sold ${pct(sold)} of launch buy (> ${pct(cfg.maxDevSoldFraction)})`, data);
    } else {
      data.soldFraction = 'unknown';
    }
    return pass(`creator holds ${pct(holding)}`, data);
  },
};
