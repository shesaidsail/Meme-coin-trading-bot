import { describe, it, expect } from 'vitest';
import { token2022Filter } from '../../../src/filters/token2022.js';
import { makeCtx, abuMintInfo, fixture } from '../../helpers/filter-ctx.js';
import type { RugcheckReport } from '../../../src/clients/rugcheck.js';

describe('token2022 filter', () => {
  it('passes a plain SPL token', async () => {
    const r = await token2022Filter.check(makeCtx({ mint: { ...abuMintInfo(), isToken2022: false, extensions: [] } }).ctx);
    expect(r.status).toBe('pass');
  });

  it('passes a pump.fun Token-2022 mint with only metadata extensions (real data)', async () => {
    const r = await token2022Filter.check(makeCtx().ctx);
    expect(r.status).toBe('pass');
  });

  it.each(['transferFeeConfig', 'transferHook', 'permanentDelegate', 'nonTransferable', 'defaultAccountState', 'pausableConfig'])(
    'fails with %s',
    async (ext) => {
      const r = await token2022Filter.check(makeCtx({ mint: { ...abuMintInfo(), extensions: ['metadataPointer', ext] } }).ctx);
      expect(r.status).toBe('fail');
      expect(r.reason).toContain(ext);
    },
  );

  it('falls back to RugCheck extensions (real report with transferFeeConfig)', async () => {
    const report = fixture<RugcheckReport>('rugcheck-report-lp-unlocked-transferfee.json');
    const r = await token2022Filter.check(makeCtx({ mint: new Error('rpc down'), report }).ctx);
    expect(r).toMatchObject({ status: 'fail', data: { source: 'rugcheck' } });
    expect(r.reason).toContain('transferFeeConfig');
  });

  it('respects a configured allowlist', async () => {
    const r = await token2022Filter.check(
      makeCtx({
        mint: { ...abuMintInfo(), extensions: ['metadataPointer', 'tokenMetadata', 'mintCloseAuthority'] },
        config: { filters: { token2022: { allowedExtensions: ['metadataPointer', 'tokenMetadata', 'mintCloseAuthority'] } } },
      }).ctx,
    );
    expect(r.status).toBe('pass');
  });
});
