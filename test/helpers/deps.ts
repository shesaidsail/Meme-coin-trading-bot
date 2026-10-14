import { Writable } from 'node:stream';
import { Storage } from '../../src/storage/store.js';
import { parseConfig } from '../../src/config/load.js';
import type { Config } from '../../src/config/schema.js';
import type { Secrets } from '../../src/config/load.js';
import { createClients } from '../../src/clients/index.js';
import { createLogger, type Logger } from '../../src/util/logger.js';
import { FakeClock } from '../../src/util/clock.js';
import { solToLamports } from '../../src/util/units.js';
import { FakeFetch } from './fake-fetch.js';

export const NOW = Date.parse('2026-10-14T14:00:00Z');

export function silentLogger(): { logger: Logger; lines: string[] } {
  const lines: string[] = [];
  const stream = new Writable({
    write(chunk, _e, cb) {
      lines.push(chunk.toString());
      cb();
    },
  });
  return { logger: createLogger({ level: 'debug' }, stream), lines };
}

/** Deep-merges plain objects (arrays and scalars replace). */
export function merge<T>(base: T, over: unknown): T {
  if (over === undefined) return base;
  if (typeof base !== 'object' || base === null || Array.isArray(base) || typeof over !== 'object' || over === null || Array.isArray(over)) {
    return over as T;
  }
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  for (const [k, v] of Object.entries(over as Record<string, unknown>)) out[k] = merge(out[k], v);
  return out as T;
}

export function testConfig(over: unknown = {}): Config {
  return parseConfig(merge({ storage: { path: ':memory:' } }, over));
}

export const noSecrets: Secrets = {
  rpcUrl: null,
  birdeyeApiKey: null,
  jupiterApiKey: null,
  rugcheckApiKey: null,
  walletPrivateKey: null,
};

/** Storage + clients wired to a FakeFetch and a FakeClock whose sleep advances time instantly. */
export function makeDeps(opts: { config?: unknown; secrets?: Partial<Secrets> } = {}) {
  const config = testConfig(opts.config);
  const clock = new FakeClock(NOW);
  const storage = Storage.open({ path: ':memory:', mode: 'paper', clock });
  storage.ledger.initialise(solToLamports(config.paper.startingSol), clock.now());
  const fake = new FakeFetch();
  const { logger, lines } = silentLogger();
  const sleeps: number[] = [];
  const sleep = async (ms: number) => {
    sleeps.push(ms);
    clock.advance(ms);
  };
  const secrets = { ...noSecrets, ...opts.secrets };
  const clients = createClients({ config, secrets, storage, clock, logger, fetch: fake.fetch, sleep });
  return { config, clock, storage, fake, logger, logLines: lines, sleeps, clients, secrets };
}
