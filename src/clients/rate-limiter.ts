import type { Clock } from '../util/clock.js';

export type Sleep = (ms: number) => Promise<void>;
export const realSleep: Sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Sliding-window limiter enforcing both a per-second and a per-minute cap,
 * plus an explicit pause (set when a provider answers 429 / retry-after).
 * Calls are serialised so concurrent callers queue in order.
 */
export class RateLimiter {
  private readonly stamps: number[] = [];
  private pausedUntil = 0;
  private queue: Promise<void> = Promise.resolve();

  constructor(
    private readonly limits: { maxPerSecond: number; maxPerMinute: number },
    private readonly clock: Clock,
    private readonly sleep: Sleep = realSleep,
  ) {}

  acquire(): Promise<void> {
    const next = this.queue.then(() => this.waitForSlot());
    // Keep the chain alive even if a waiter throws.
    this.queue = next.catch(() => undefined);
    return next;
  }

  /** Blocks all calls until `ts` (epoch ms). Never shortens an existing pause. */
  pauseUntil(ts: number): void {
    this.pausedUntil = Math.max(this.pausedUntil, ts);
  }

  private async waitForSlot(): Promise<void> {
    for (;;) {
      const now = this.clock.now();
      while (this.stamps.length && this.stamps[0]! <= now - 60_000) this.stamps.shift();
      const inLastSecond = this.stamps.filter((t) => t > now - 1_000);

      let wait = 0;
      if (now < this.pausedUntil) wait = this.pausedUntil - now;
      else if (inLastSecond.length >= this.limits.maxPerSecond) wait = inLastSecond[0]! + 1_000 - now;
      else if (this.stamps.length >= this.limits.maxPerMinute) wait = this.stamps[0]! + 60_000 - now;

      if (wait <= 0) {
        this.stamps.push(now);
        return;
      }
      await this.sleep(wait);
    }
  }
}
