import type { TokenContext } from './context.js';
import { type Filter, type CheckResult, pass, fail, missing } from './types.js';

/** On-chain mint account first; RugCheck's view as a fallback (and recorded for comparison). */
async function authorityCheck(ctx: TokenContext, which: 'mintAuthority' | 'freezeAuthority', label: string): Promise<CheckResult> {
  const m = await ctx.mintInfo();
  if (m.ok) {
    const auth = m.value[which];
    const data = { source: 'onchain', [which]: auth };
    return auth ? fail(`${label} authority still set (${auth})`, data) : pass(`${label} authority revoked (on-chain)`, data);
  }
  const r = await ctx.rugcheck();
  if (r.ok) {
    const auth = r.value[which] ?? null;
    const data = { source: 'rugcheck', onchainError: m.reason, [which]: auth };
    return auth ? fail(`${label} authority still set (${auth}, per RugCheck)`, data) : pass(`${label} authority revoked (per RugCheck; on-chain unavailable)`, data);
  }
  return missing(`${label} authority unknown (on-chain: ${m.reason}; RugCheck: ${r.reason})`);
}

export const mintAuthorityFilter: Filter = {
  name: 'mintAuthority',
  check: (ctx) => authorityCheck(ctx, 'mintAuthority', 'mint'),
};

export const freezeAuthorityFilter: Filter = {
  name: 'freezeAuthority',
  check: (ctx) => authorityCheck(ctx, 'freezeAuthority', 'freeze'),
};
