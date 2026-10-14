import type { Executor, SwapRequest, SwapResult } from './types.js';

/**
 * Live execution is intentionally not implemented until paper mode has been
 * verified end to end (step 5). Constructing it fails loudly so that a
 * `mode: live` config can never silently trade on paper or vice versa.
 */
export class LiveExecutor implements Executor {
  readonly mode = 'live' as const;

  constructor() {
    throw new Error('Live trading is not implemented yet. Run in paper mode (mode: paper).');
  }

  buy(_mint: string, _req: SwapRequest): Promise<SwapResult> {
    throw new Error('not implemented');
  }

  sell(_mint: string, _req: SwapRequest): Promise<SwapResult> {
    throw new Error('not implemented');
  }
}
