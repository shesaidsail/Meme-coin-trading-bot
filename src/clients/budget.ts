import type { Clock } from '../util/clock.js';
import type { UsageRepo } from '../storage/usage.repo.js';
import { BudgetExhaustedError } from './errors.js';

/**
 * critical: exit quotes and sells. May spend the reserved part of the budget.
 * normal:   discovery and filtering. Stops once only the reserve is left.
 */
export type Priority = 'critical' | 'normal';

/** Daily per-provider call budget, persisted in SQLite so restarts don't reset it. */
export class Budget {
  constructor(
    private readonly provider: string,
    private readonly cfg: { unitsPerDay: number; reserveFraction: number },
    private readonly usage: UsageRepo,
    private readonly clock: Clock,
  ) {}

  used(): number {
    return this.usage.get(this.provider, this.clock.now()).units;
  }

  /** Units still available to callers of the given priority today. */
  remaining(priority: Priority): number {
    const cap =
      priority === 'critical'
        ? this.cfg.unitsPerDay
        : Math.floor(this.cfg.unitsPerDay * (1 - this.cfg.reserveFraction));
    return Math.max(0, cap - this.used());
  }

  /** Throws BudgetExhaustedError if `units` cannot be spent at this priority. */
  check(units: number, priority: Priority): void {
    if (units > this.remaining(priority)) {
      throw new BudgetExhaustedError(
        this.provider,
        `daily budget exhausted for ${priority} calls (${this.used()}/${this.cfg.unitsPerDay} units used, ` +
          `${Math.round(this.cfg.reserveFraction * 100)}% reserved for exits)`,
      );
    }
  }

  charge(units: number): void {
    this.usage.add(this.provider, this.clock.now(), { units, calls: 1 });
  }
}
