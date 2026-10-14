import { describe, it, expect } from 'vitest';
import { makeDeps } from '../helpers/deps.js';
import { rpcOk } from '../helpers/fake-fetch.js';
import { fixture, ABU_MINT, SOL } from '../helpers/filter-ctx.js';

describe('JupiterClient', () => {
  it('parses a real quote (priceImpactPct is a fraction)', async () => {
    const { clients, fake } = makeDeps();
    fake.on(/\/quote\?/, { body: fixture('jupiter-quote-buy.json') });
    const r = await clients.jupiter.quote({ inputMint: SOL, outputMint: ABU_MINT, amount: 500_000_000n, slippageBps: 300 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.quote.inAmount).toBe(500_000_000n);
    expect(r.quote.outAmount).toBe(224_888_830_478n);
    expect(r.quote.minOutAmount).toBe(218_142_165_564n);
    expect(r.quote.priceImpact).toBeCloseTo(0.01447, 4);
    expect(r.quote.routeLabels).toEqual(['Pump.fun Amm']);
    const url = new URL(fake.calls[0]!.url);
    expect(url.pathname).toBe('/swap/v1/quote');
    expect(url.searchParams.get('amount')).toBe('500000000');
    expect(url.searchParams.get('swapMode')).toBe('ExactIn');
  });

  it('returns no-route / not-tradable as values, not errors', async () => {
    const { clients, fake } = makeDeps();
    fake
      .on(/outputMint=A/, { status: 400, body: { error: 'The token A is not tradable', errorCode: 'TOKEN_NOT_TRADABLE' } })
      .on(/outputMint=B/, { status: 400, body: { error: 'Could not find any route', errorCode: 'COULD_NOT_FIND_ANY_ROUTE' } });
    expect(await clients.jupiter.quote({ inputMint: SOL, outputMint: 'A', amount: 1n, slippageBps: 1 })).toMatchObject({ ok: false, reason: 'not_tradable' });
    expect(await clients.jupiter.quote({ inputMint: SOL, outputMint: 'B', amount: 1n, slippageBps: 1 })).toMatchObject({ ok: false, reason: 'no_route' });
  });

  it('prices SOL in USD from a SOL→USDC quote', async () => {
    const { clients, fake, config } = makeDeps();
    fake.on(/\/quote\?/, { body: { ...fixture<object>('jupiter-quote-buy.json'), outAmount: '105250000' } });
    expect(await clients.jupiter.solUsd(config.chain.solMint, config.chain.usdcMint)).toBeCloseTo(105.25);
  });
});

describe('DexScreenerClient', () => {
  it('keeps only Solana refs from discovery feeds', async () => {
    const { clients, fake } = makeDeps();
    fake.on(/token-profiles\/latest/, { body: fixture('dexscreener-profiles.json') });
    const mints = await clients.dexscreener.latestProfiles();
    const all = fixture<{ chainId: string; tokenAddress: string }[]>('dexscreener-profiles.json');
    const expected = new Set(all.filter((x) => x.chainId === 'solana').map((x) => x.tokenAddress));
    expect(new Set(mints)).toEqual(expected);
  });

  it('prices mints 30 per request', async () => {
    const { clients, fake } = makeDeps();
    fake.on(/tokens\/v1\/solana/, { body: fixture('dexscreener-tokens.json') });
    const mints = Array.from({ length: 61 }, (_, i) => `M${i}`);
    await clients.dexscreener.pairsForTokens(mints);
    expect(fake.calls.map((c) => new URL(c.url).pathname.split('/').pop()!.split(',').length)).toEqual([30, 30, 1]);
  });
});

describe('RugcheckClient', () => {
  it('parses real reports', async () => {
    const { clients, fake } = makeDeps();
    fake.on(/report/, { body: fixture('rugcheck-report-lp-unlocked-transferfee.json') });
    const r = await clients.rugcheck.report('X');
    expect(r!.score_normalised).toBe(51);
    expect(r!.risks![0]!.level).toBe('danger');
    expect(r!.markets!.length).toBeGreaterThan(1);
  });

  it('returns null for unknown tokens and [] for null lists', async () => {
    const { clients, fake } = makeDeps();
    fake.on(/report/, { status: 404, body: { error: 'not found' } }).on(/trending/, { body: null }).on(/new_tokens/, { body: fixture('rugcheck-new-tokens.json') });
    expect(await clients.rugcheck.report('X')).toBeNull();
    expect(await clients.rugcheck.trending()).toEqual([]);
    expect((await clients.rugcheck.newTokens()).length).toBe(10);
  });
});

describe('SolanaRpcClient.getMintInfo', () => {
  it('decodes a Token-2022 mint with extensions from jsonParsed', async () => {
    const { clients, fake } = makeDeps();
    fake.on(/getAccountInfo/, { body: fixture('rpc-mint-token2022.json') });
    const m = await clients.rpc.getMintInfo(ABU_MINT);
    expect(m).toMatchObject({ isToken2022: true, decimals: 6, mintAuthority: null, freezeAuthority: null, extensions: ['metadataPointer', 'tokenMetadata'] });
    expect(m!.supply).toBe(965_994_794_104_096n);
  });

  it('returns null for a missing account', async () => {
    const { clients, fake } = makeDeps();
    fake.on(/getAccountInfo/, rpcOk({ value: null }));
    expect(await clients.rpc.getMintInfo('X')).toBeNull();
  });
});

describe('createClients', () => {
  it('sends API keys only as headers, and only for their own provider', async () => {
    const { Secret } = await import('../../src/util/secret.js');
    const { clients, fake } = makeDeps({ secrets: { birdeyeApiKey: new Secret('BE'), jupiterApiKey: new Secret('JK') } });
    expect(clients.birdeye).not.toBeNull();
    let seen: Record<string, string> = {};
    fake.on(/birdeye/, (_u, init) => ((seen = init.headers as Record<string, string>), { body: { success: true, data: { items: [{ address: 'A' }] } } }));
    expect(await clients.birdeye!.tokensInMarketCapBand(1, 2)).toEqual(['A']);
    expect(seen['X-API-KEY']).toBe('BE');
    expect(seen['x-chain']).toBe('solana');
    expect(fake.calls[0]!.url).not.toContain('BE');
  });

  it('has no Birdeye client without a key', () => {
    expect(makeDeps().clients.birdeye).toBeNull();
  });
});
