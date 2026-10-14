/** Injectable time source so timers (e.g. the 48h time stop) are testable. */
export interface Clock {
  /** Milliseconds since the Unix epoch. */
  now(): number;
}

export const systemClock: Clock = { now: () => Date.now() };

export class FakeClock implements Clock {
  constructor(private t: number = Date.UTC(2026, 0, 1)) {}
  now(): number {
    return this.t;
  }
  set(t: number): void {
    this.t = t;
  }
  advance(ms: number): void {
    this.t += ms;
  }
}

export const HOUR_MS = 3_600_000;
export const MINUTE_MS = 60_000;
