import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { HttpClient } from '../../src/clients/http.js';
import { ApiError, BudgetExhaustedError } from '../../src/clients/errors.js';
import { SolanaRpcClient, METHOD_COOLDOWN_MS } from '../../src/clients/solana-rpc.js';
import { FakeFetch, rpcOk } from '../helpers/fake-fetch.js';
import { makeDeps } from '../helpers/deps.js';

const Any = z.unknown();

function client(over: Partial<{ maxRetries: number; unitsPerDay: number; reserveFraction: number; sampleMs: number; baseUrl: string }> = {}) {
  const d = makeDeps();
  const fake = new FakeFetch();
  const sleeps: number[] = [];
  const http = new HttpClient(
    {
      name: 'test',
      baseUrl: over.baseUrl ?? 'https://api.test/v1',
      timeoutMs: 1000,
      maxRetries: over.maxRetries ?? 2,
      rateLimit: { maxPerSecond: 100, maxPerMinute: 1000 },
      budget: { unitsPerDay: over.unitsPerDay ?? 1000, reserveFraction: over.reserveFraction ?? 0.25 },
    },
    {
      clock: d.clock,
      logger: d.logger,
      usage: d.storage.usage,
      rateObservations: d.storage.rateObservations,
      rateHeaderSampleMs: over.sampleMs ?? 60_000,
      fetch: fake.fetch,
      sleep: async (ms) => {
        sleeps.push(ms);
        d.clock.advance(ms);
      },
    },
  );
  return { ...d, http, fake, sleeps };
}

describe('HttpClient', () => {
  it('validates responses against the schema', async () => {
    const { http, fake } = client();
    fake.on(/\/ok/, { body: { a: 1 } }).on(/\/bad/, { body: { a: 'x' } });
    await expect(http.request({ path: '/ok', schema: z.object({ a: z.number() }) })).resolves.toEqual({ a: 1 });
    await expect(http.request({ path: '/bad', schema: z.object({ a: z.number() }) })).rejects.toMatchObject({ kind: 'schema' });
  });

  it('retries 429 honouring retry-after, counts throttles, and always records 429 headers', async () => {
    const { http, fake, sleeps, storage, clock } = client();
    fake.on(/\/x/, { status: 429, headers: { 'retry-after': '7', 'x-rate-limit-remaining': '0' } }, { body: {}, headers: { 'x-rate-limit-remaining': '9' } });
    await http.request({ path: '/x', schema: Any });
    expect(sleeps[0]).toBeGreaterThanOrEqual(7000);
    expect(storage.usage.get('test', clock.now())).toMatchObject({ calls: 2, throttled: 1 });
    const obs = storage.rateObservations.latest('test', 5);
    expect(obs.some((o) => o.status === 429 && o.headers['retry-after'] === '7')).toBe(true);
  });

  it('gives up after maxRetries on persistent 429', async () => {
    const { http, fake } = client({ maxRetries: 1 });
    fake.on(/\/x/, { status: 429 });
    await expect(http.request({ path: '/x', schema: Any })).rejects.toMatchObject({ kind: 'rate_limited', status: 429 });
    expect(fake.calls).toHaveLength(2);
  });

  it('retries 5xx and network errors, but not other 4xx', async () => {
    const { http, fake } = client();
    fake.on(/\/flaky/, { status: 503 }, { body: { ok: true } });
    await expect(http.request({ path: '/flaky', schema: Any })).resolves.toEqual({ ok: true });

    let n = 0;
    fake.on(/\/net/, () => {
      if (n++ === 0) throw new TypeError('fetch failed');
      return { body: 1 };
    });
    await expect(http.request({ path: '/net', schema: Any })).resolves.toBe(1);

    fake.on(/\/missing/, { status: 404, body: { error: 'nope' } });
    await expect(http.request({ path: '/missing', schema: Any })).rejects.toMatchObject({ kind: 'http', status: 404, body: { error: 'nope' } });
    expect(fake.count(/\/missing/)).toBe(1);
  });

  it('enforces the daily budget and keeps the reserve for critical calls', async () => {
    const { http, fake } = client({ unitsPerDay: 4, reserveFraction: 0.5 });
    fake.on(/./, { body: {} });
    await http.request({ path: '/a', schema: Any });
    await http.request({ path: '/a', schema: Any });
    // Normal calls may only use 50% (2 units).
    await expect(http.request({ path: '/a', schema: Any })).rejects.toBeInstanceOf(BudgetExhaustedError);
    // Critical calls (exits) may use the reserve.
    await http.request({ path: '/a', schema: Any, priority: 'critical' });
    await http.request({ path: '/a', schema: Any, priority: 'critical' });
    await expect(http.request({ path: '/a', schema: Any, priority: 'critical' })).rejects.toBeInstanceOf(BudgetExhaustedError);
    expect(fake.calls).toHaveLength(4);
  });

  it('budget usage persists in storage (survives restarts) and resets at UTC midnight', async () => {
    const { http, fake, storage, clock } = client({ unitsPerDay: 2, reserveFraction: 0 });
    fake.on(/./, { body: {} });
    await http.request({ path: '/a', schema: Any, units: 2 });
    expect(storage.usage.get('test', clock.now()).units).toBe(2);
    await expect(http.request({ path: '/a', schema: Any })).rejects.toBeInstanceOf(BudgetExhaustedError);
    clock.advance(24 * 3_600_000);
    await expect(http.request({ path: '/a', schema: Any })).resolves.toEqual({});
  });

  it('samples rate-limit headers at most once per interval', async () => {
    const { http, fake, storage, clock } = client({ sampleMs: 60_000 });
    fake.on(/./, { body: {}, headers: { 'x-ratelimit-remaining': '5', 'x-other': 'y' } });
    await http.request({ path: '/a', schema: Any });
    await http.request({ path: '/a', schema: Any });
    expect(storage.rateObservations.latest('test', 10)).toHaveLength(1);
    expect(storage.rateObservations.latest('test')[0]!.headers).toEqual({ 'x-ratelimit-remaining': '5' });
    clock.advance(60_000);
    await http.request({ path: '/a', schema: Any });
    expect(storage.rateObservations.latest('test', 10)).toHaveLength(2);
  });

  it('labels endpoints without addresses and never stores query-string keys', async () => {
    const { http, fake, storage } = client({ baseUrl: 'https://rpc.test/?api-key=SECRET' });
    fake.on(/./, { body: {}, headers: { 'x-ratelimit-remaining': '1' } });
    await http.request({ path: '/tokens/6hTLdzZaaCjmqtn7RtaEMQsCbXT5Pg8q76tRViEGpump/report', schema: Any });
    const [o] = storage.rateObservations.latest('test');
    expect(o!.endpoint).toBe('/tokens/:id/report');
    expect(JSON.stringify(o)).not.toContain('SECRET');
  });
});

describe('SolanaRpcClient', () => {
  it('treats JSON-RPC throttling in a 200 body as a 429 and labels by method', async () => {
    const { http, fake, storage, clock } = client({ baseUrl: 'https://rpc.test/?api-key=k' });
    const rpc = new SolanaRpcClient(http, () => clock.now());
    fake.on(/getTokenSupply/, { body: { jsonrpc: '2.0', id: 1, error: { code: 429, message: 'Too many requests' } } }, rpcOk({ value: { amount: '5' } }));
    await expect(rpc.getTokenSupply('Mint')).resolves.toBe(5n);
    expect(storage.usage.get('test', clock.now()).throttled).toBe(1);
    expect(storage.rateObservations.latest('test')[0]!.endpoint).toBe('rpc:getTokenSupply');
    // The configured RPC URL (with its key) is used as-is.
    expect(fake.calls[0]!.url).toBe('https://rpc.test/?api-key=k');
  });

  it('does not retry getTokenLargestAccounts and cools the method down after a 429', async () => {
    const { http, fake, clock } = client();
    const rpc = new SolanaRpcClient(http, () => clock.now());
    fake.on(/getTokenLargestAccounts/, { status: 429, headers: { 'retry-after': '10', 'x-ratelimit-method-limit': '0' } });
    await expect(rpc.getTokenLargestAccounts('Mint')).rejects.toMatchObject({ kind: 'rate_limited' });
    expect(fake.count(/getTokenLargestAccounts/)).toBe(1);
    // Within the cooldown it fails fast, without a request.
    await expect(rpc.getTokenLargestAccounts('Mint')).rejects.toThrow(/cooling down/);
    expect(fake.count(/getTokenLargestAccounts/)).toBe(1);
    clock.advance(METHOD_COOLDOWN_MS);
    fake.on(/getTokenLargestAccounts/, rpcOk({ value: [] }));
    await expect(rpc.getTokenLargestAccounts('Mint')).rejects.toBeInstanceOf(ApiError); // still the first route (429)
  });

  it('requests transactions up to version 1 (mainnet carries v1 transactions)', async () => {
    const { http, fake, clock } = client();
    const rpc = new SolanaRpcClient(http, () => clock.now());
    fake.on(/getTransaction/, rpcOk(null));
    await rpc.getTransaction('sig');
    expect((fake.calls[0]!.body as { params: [string, { maxSupportedTransactionVersion: number }] }).params[1].maxSupportedTransactionVersion).toBe(1);
  });

  it('surfaces other RPC errors', async () => {
    const { http, fake, clock } = client();
    const rpc = new SolanaRpcClient(http, () => clock.now());
    fake.on(/getTokenSupply/, { body: { jsonrpc: '2.0', id: 1, error: { code: -32602, message: 'Invalid param' } } });
    await expect(rpc.getTokenSupply('x')).rejects.toThrow(/Invalid param/);
  });
});
