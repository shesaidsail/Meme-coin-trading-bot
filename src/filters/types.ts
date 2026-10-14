import type { FilterName } from '../config/schema.js';
import type { TokenContext } from './context.js';

export type CheckData = Record<string, unknown>;

/**
 * What a filter decides. `missing` means the data needed to decide was not
 * available; the pipeline maps it to reject / skip / warn per config.
 */
export type CheckResult =
  | { status: 'pass'; reason: string | null; data?: CheckData }
  | { status: 'fail'; reason: string; data?: CheckData }
  | { status: 'missing'; reason: string; data?: CheckData };

export interface Filter {
  readonly name: FilterName;
  check(ctx: TokenContext): Promise<CheckResult>;
}

export const pass = (reason: string | null = null, data?: CheckData): CheckResult => ({ status: 'pass', reason, ...(data ? { data } : {}) });
export const fail = (reason: string, data?: CheckData): CheckResult => ({ status: 'fail', reason, ...(data ? { data } : {}) });
export const missing = (reason: string, data?: CheckData): CheckResult => ({ status: 'missing', reason, ...(data ? { data } : {}) });

export const pct = (f: number, digits = 1): string => `${(f * 100).toFixed(digits)}%`;
export const usd = (n: number): string => `$${Math.round(n).toLocaleString('en-US')}`;
