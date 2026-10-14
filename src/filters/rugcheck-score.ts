import { type Filter, pass, fail, missing } from './types.js';

/**
 * RugCheck's normalised score is a risk score (0 safest … 100 riskiest).
 * Rejects scores above the threshold, tokens RugCheck marks rugged, and
 * (optionally) any "danger"-level risk.
 */
export const rugcheckScoreFilter: Filter = {
  name: 'rugcheckScore',
  async check(ctx) {
    const cfg = ctx.config.filters.rugcheckScore;
    const r = await ctx.rugcheck();
    if (!r.ok) return missing(r.reason);
    const score = r.value.score_normalised;
    const risks = r.value.risks ?? [];
    const danger = risks.filter((x) => x.level === 'danger').map((x) => x.name);
    const data = { source: 'rugcheck', scoreNormalised: score ?? null, scoreRaw: r.value.score ?? null, risks: risks.map((x) => `${x.level}: ${x.name}`) };
    if (r.value.rugged) return fail('RugCheck marks token as rugged', data);
    if (score === null || score === undefined) return missing('RugCheck report has no score', data);
    if (score > cfg.maxNormalisedRiskScore) return fail(`RugCheck risk score ${score} > ${cfg.maxNormalisedRiskScore}`, data);
    if (cfg.rejectOnDangerRisks && danger.length) return fail(`RugCheck danger risk(s): ${danger.join('; ')}`, data);
    return pass(`RugCheck risk score ${score}`, data);
  },
};
