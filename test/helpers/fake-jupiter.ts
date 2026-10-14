import type { QuoteRequest, QuoteResult } from '../../src/clients/jupiter.js';
import { quote } from './filter-ctx.js';

export type QuoteFn = (req: QuoteRequest, n: number) => QuoteResult | Error;

/**
 * Jupiter stub driven by a function of (request, call index). Helpers below
 * build quotes at a fixed price (lamports per token) with a given impact.
 */
export class FakeJupiter {
  readonly requests: QuoteRequest[] = [];
  constructor(public fn: QuoteFn) {}

  async quote(req: QuoteRequest): Promise<QuoteResult> {
    this.requests.push(req);
    const r = this.fn(req, this.requests.length - 1);
    if (r instanceof Error) throw r;
    return r;
  }

  async solUsd(): Promise<number> {
    return 150;
  }
}

/**
 * A successful quote converting `amount` at `rate` (out per in) and losing
 * `impact` of it to price impact, with `minOut` at the requested slippage.
 */
export function priced(req: QuoteRequest, rate: number, impact = 0): QuoteResult {
  const out = BigInt(Math.floor(Number(req.amount) * rate * (1 - impact)));
  const r = quote(req.inputMint, req.outputMint, req.amount, out, impact);
  if (r.ok) r.quote.minOutAmount = (out * BigInt(10_000 - req.slippageBps)) / 10_000n;
  return r;
}

export const noRoute: QuoteResult = { ok: false, reason: 'no_route', message: 'Could not find any route' };
