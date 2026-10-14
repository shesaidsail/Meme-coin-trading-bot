import type { Filter } from './types.js';
import { liquidityFilter } from './liquidity.js';
import { tokenAgeFilter } from './token-age.js';
import { mintAuthorityFilter, freezeAuthorityFilter } from './authorities.js';
import { token2022Filter } from './token2022.js';
import { rugcheckScoreFilter } from './rugcheck-score.js';
import { lpLockedFilter } from './lp-locked.js';
import { holderCountFilter } from './holder-count.js';
import { holderConcentrationFilter } from './holder-concentration.js';
import { devWalletFilter } from './dev-wallet.js';
import { bundledLaunchFilter } from './bundled-launch.js';
import { honeypotFilter } from './honeypot.js';

/**
 * Evaluation order: cheapest data first, so that with stopOnFirstReject most
 * tokens are rejected before the expensive calls (history walk, quotes).
 *   scanner data → 1 RPC read → 1 RugCheck report → RPC holders → history → 2 quotes
 */
export const ALL_FILTERS: Filter[] = [
  liquidityFilter,
  tokenAgeFilter,
  mintAuthorityFilter,
  freezeAuthorityFilter,
  token2022Filter,
  rugcheckScoreFilter,
  lpLockedFilter,
  holderCountFilter,
  holderConcentrationFilter,
  bundledLaunchFilter,
  devWalletFilter,
  honeypotFilter,
];

export * from './types.js';
export { TokenContext } from './context.js';
export { runPipeline } from './pipeline.js';
