export type Mode = 'paper' | 'live';
export type PositionStatus = 'open' | 'closed';
export type ExitReason = 'take_profit' | 'time_stop' | 'stop_loss' | 'manual';
export type TradeSide = 'buy' | 'sell';
export type TradeStatus = 'filled' | 'partial' | 'failed';
export type FilterOutcome = 'pass' | 'fail' | 'insufficient_data' | 'skipped' | 'warn';
export type AuditLevel = 'info' | 'warn' | 'error';

export interface Position {
  id: number;
  mint: string;
  symbol: string | null;
  mode: Mode;
  status: PositionStatus;
  tokenDecimals: number;
  initialTokenAmountRaw: bigint;
  tokenAmountRaw: bigint;
  /** Total SOL spent to open, including fees, priority fee and ATA rent. */
  costBasisLamports: bigint;
  entrySolUsd: number | null;
  entryMcapUsd: number | null;
  buyCostFraction: number;
  sellCostFraction: number;
  tpGrossMultiplier: number;
  /** Net SOL proceeds (after sell costs) at which take-profit fires. */
  tpTargetNetLamports: bigint;
  enteredAt: number;
  timeStopAt: number;
  stopLossFraction: number | null;
  shadowSlTriggeredAt: number | null;
  shadowSlValueLamports: bigint | null;
  lastQuoteLamports: bigint | null;
  lastQuoteAt: number | null;
  peakQuoteLamports: bigint | null;
  consecutiveQuoteFailures: number;
  unquotableSince: number | null;
  /** SOL received from sells so far (partial fills accumulate here). */
  realizedLamports: bigint;
  exitReason: ExitReason | null;
  exitedAt: number | null;
  exitSolUsd: number | null;
}

export type NewPosition = Pick<
  Position,
  | 'mint'
  | 'symbol'
  | 'mode'
  | 'tokenDecimals'
  | 'tokenAmountRaw'
  | 'costBasisLamports'
  | 'entrySolUsd'
  | 'entryMcapUsd'
  | 'buyCostFraction'
  | 'sellCostFraction'
  | 'tpGrossMultiplier'
  | 'tpTargetNetLamports'
  | 'enteredAt'
  | 'timeStopAt'
  | 'stopLossFraction'
>;

export interface Trade {
  id: number;
  positionId: number | null;
  mint: string;
  side: TradeSide;
  mode: Mode;
  status: TradeStatus;
  reason: string | null;
  attempt: number;
  slippageBps: number | null;
  inAmountRaw: bigint;
  inFilledRaw: bigint;
  outAmountRaw: bigint;
  quotedOutRaw: bigint | null;
  priceImpact: number | null;
  feeLamports: bigint;
  solUsd: number | null;
  signature: string | null;
  error: string | null;
  createdAt: number;
}

export type NewTrade = Omit<Trade, 'id'>;
