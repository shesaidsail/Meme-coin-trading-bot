import type { Config } from '../config/schema.js';
import type { JupiterClient } from '../clients/jupiter.js';
import type { Clock } from '../util/clock.js';
import type { Logger } from '../util/logger.js';

/** SOL/USD from Jupiter, cached; used for USD reporting only, never for trading decisions. */
export class SolPrice {
  private cached: { usd: number; at: number } | null = null;

  constructor(
    private readonly deps: { jupiter: Pick<JupiterClient, 'solUsd'>; config: Config; clock: Clock; logger: Logger },
    private readonly maxAgeMs = 60_000,
  ) {}

  /** Latest SOL/USD, or the last known value (or null) if the lookup fails. */
  async get(): Promise<number | null> {
    const now = this.deps.clock.now();
    if (this.cached && now - this.cached.at < this.maxAgeMs) return this.cached.usd;
    try {
      const usd = await this.deps.jupiter.solUsd(this.deps.config.chain.solMint, this.deps.config.chain.usdcMint);
      this.cached = { usd, at: now };
      return usd;
    } catch (e) {
      this.deps.logger.warn({ err: e }, 'sol_usd_unavailable');
      return this.cached?.usd ?? null;
    }
  }
}
