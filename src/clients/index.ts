import type { Config, ApiName } from '../config/schema.js';
import type { Secrets } from '../config/load.js';
import type { Storage } from '../storage/store.js';
import type { Clock } from '../util/clock.js';
import type { Logger } from '../util/logger.js';
import { HttpClient, type FetchFn } from './http.js';
import type { Sleep } from './rate-limiter.js';
import { JupiterClient } from './jupiter.js';
import { DexScreenerClient } from './dexscreener.js';
import { RugcheckClient } from './rugcheck.js';
import { SolanaRpcClient } from './solana-rpc.js';
import { BirdeyeClient } from './birdeye.js';

export interface Clients {
  jupiter: JupiterClient;
  dexscreener: DexScreenerClient;
  rugcheck: RugcheckClient;
  rpc: SolanaRpcClient;
  /** Null unless BIRDEYE_API_KEY is set. */
  birdeye: BirdeyeClient | null;
  http: Partial<Record<ApiName, HttpClient>>;
}

export interface ClientDeps {
  config: Config;
  secrets: Secrets;
  storage: Storage;
  clock: Clock;
  logger: Logger;
  fetch?: FetchFn;
  sleep?: Sleep;
}

export function createClients(d: ClientDeps): Clients {
  const make = (name: ApiName, overrides: { baseUrl?: string; headers?: Record<string, string> } = {}) => {
    const c = d.config.apis[name];
    return new HttpClient(
      {
        name,
        baseUrl: overrides.baseUrl ?? c.baseUrl,
        timeoutMs: c.timeoutMs,
        maxRetries: c.maxRetries,
        rateLimit: c.rateLimit,
        budget: c.budget,
        ...(overrides.headers ? { defaultHeaders: overrides.headers } : {}),
      },
      {
        clock: d.clock,
        logger: d.logger,
        usage: d.storage.usage,
        rateObservations: d.storage.rateObservations,
        rateHeaderSampleMs: d.config.logging.rateHeaderSampleSec * 1000,
        ...(d.fetch ? { fetch: d.fetch } : {}),
        ...(d.sleep ? { sleep: d.sleep } : {}),
      },
    );
  };

  const jupKey = d.secrets.jupiterApiKey?.reveal();
  const http: Partial<Record<ApiName, HttpClient>> = {
    jupiter: make('jupiter', jupKey ? { headers: { 'x-api-key': jupKey } } : {}),
    dexscreener: make('dexscreener'),
    rugcheck: make('rugcheck'),
    rpc: make('rpc', d.secrets.rpcUrl ? { baseUrl: d.secrets.rpcUrl.reveal() } : {}),
  };
  const birdeyeKey = d.secrets.birdeyeApiKey?.reveal();
  if (birdeyeKey) http.birdeye = make('birdeye', { headers: { 'X-API-KEY': birdeyeKey } });

  return {
    jupiter: new JupiterClient(http.jupiter!),
    dexscreener: new DexScreenerClient(http.dexscreener!),
    rugcheck: new RugcheckClient(http.rugcheck!),
    rpc: new SolanaRpcClient(http.rpc!, () => d.clock.now()),
    birdeye: http.birdeye ? new BirdeyeClient(http.birdeye) : null,
    http,
  };
}
