import { type Filter, pass, fail, missing } from './types.js';

/**
 * Rejects Token-2022 mints with any extension outside the allowlist
 * (transfer fees, transfer hooks, permanent delegate, non-transferable,
 * default-frozen accounts, pausable, ...). Plain SPL Token mints pass.
 */
export const token2022Filter: Filter = {
  name: 'token2022',
  async check(ctx) {
    const allowed = new Set(ctx.config.filters.token2022.allowedExtensions);
    let extensions: string[];
    let isToken2022: boolean;
    let source: string;

    const m = await ctx.mintInfo();
    if (m.ok) {
      isToken2022 = m.value.isToken2022;
      extensions = m.value.extensions;
      source = 'onchain';
    } else {
      const r = await ctx.rugcheck();
      if (!r.ok) return missing(`mint program unknown (on-chain: ${m.reason}; RugCheck: ${r.reason})`);
      isToken2022 = r.value.tokenProgram === 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';
      const ext = (r.value as { token_extensions?: Record<string, unknown> | null }).token_extensions ?? {};
      extensions = Object.entries(ext)
        .filter(([, v]) => v !== null && v !== false && v !== undefined)
        .map(([k]) => k);
      source = 'rugcheck';
    }

    const data = { source, isToken2022, extensions };
    if (!isToken2022) return pass('SPL Token (no extensions)', data);
    const bad = extensions.filter((e) => !allowed.has(e));
    if (bad.length) return fail(`Token-2022 with disallowed extension(s): ${bad.join(', ')}`, data);
    return pass(extensions.length ? `Token-2022 with allowed extensions: ${extensions.join(', ')}` : 'Token-2022 without extensions', data);
  },
};
