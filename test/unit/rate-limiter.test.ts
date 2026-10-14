import { describe, it, expect } from 'vitest';
import { RateLimiter } from '../../src/clients/rate-limiter.js';
import { FakeClock } from '../../src/util/clock.js';

function setup(limits: { maxPerSecond: number; maxPerMinute: number }) {
  const clock = new FakeClock(0);
  const sleeps: number[] = [];
  const limiter = new RateLimiter(limits, clock, async (ms) => {
    sleeps.push(ms);
    clock.advance(ms);
  });
  return { clock, sleeps, limiter };
}

describe('RateLimiter', () => {
  it('enforces the per-second cap', async () => {
    const { clock, limiter } = setup({ maxPerSecond: 2, maxPerMinute: 100 });
    const times: number[] = [];
    for (let i = 0; i < 5; i++) {
      await limiter.acquire();
      times.push(clock.now());
    }
    expect(times).toEqual([0, 0, 1000, 1000, 2000]);
  });

  it('enforces the per-minute cap', async () => {
    const { clock, limiter } = setup({ maxPerSecond: 100, maxPerMinute: 3 });
    const times: number[] = [];
    for (let i = 0; i < 4; i++) {
      await limiter.acquire();
      times.push(clock.now());
    }
    expect(times).toEqual([0, 0, 0, 60_000]);
  });

  it('honours an explicit pause (retry-after) and never shortens it', async () => {
    const { clock, limiter } = setup({ maxPerSecond: 10, maxPerMinute: 100 });
    limiter.pauseUntil(5_000);
    limiter.pauseUntil(1_000);
    await limiter.acquire();
    expect(clock.now()).toBe(5_000);
  });

  it('serves concurrent callers in order without exceeding the cap', async () => {
    const { clock, limiter } = setup({ maxPerSecond: 1, maxPerMinute: 100 });
    const order: number[] = [];
    await Promise.all([0, 1, 2].map((i) => limiter.acquire().then(() => order.push(i))));
    expect(order).toEqual([0, 1, 2]);
    expect(clock.now()).toBe(2000);
  });
});
