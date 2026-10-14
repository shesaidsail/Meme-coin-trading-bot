import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Storage } from '../../src/storage/store.js';
import type { BuyTradeInput, SellTradeInput } from '../../src/storage/store.js';
import type { Mode, NewPosition } from '../../src/storage/types.js';
import { FakeClock, HOUR_MS } from '../../src/util/clock.js';
import { solToLamports } from '../../src/util/units.js';

/** A temp directory holding a real on-disk SQLite file, so restarts can be simulated. */
export function tempDb(): { path: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'bot-test-'));
  return { path: join(dir, 'bot.db'), cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

export function openStore(path: string, clock: FakeClock, mode: Mode = 'paper'): Storage {
  return Storage.open({ path, mode, clock });
}

export function newPosition(clock: FakeClock, over: Partial<NewPosition> = {}): NewPosition {
  const enteredAt = over.enteredAt ?? clock.now();
  return {
    mint: 'MintAAAA1111111111111111111111111111111111',
    symbol: 'AAA',
    mode: 'paper',
    tokenDecimals: 6,
    tokenAmountRaw: 1_000_000_000n,
    costBasisLamports: solToLamports(0.5),
    entrySolUsd: 150,
    entryMcapUsd: 300_000,
    buyCostFraction: 0.03,
    sellCostFraction: 0.03,
    tpGrossMultiplier: 2.657,
    tpTargetNetLamports: solToLamports(1.25),
    enteredAt,
    timeStopAt: enteredAt + 48 * HOUR_MS,
    stopLossFraction: null,
    ...over,
  };
}

export function buyFill(over: Partial<BuyTradeInput> = {}): BuyTradeInput {
  return {
    status: 'filled',
    reason: 'entry',
    attempt: 1,
    slippageBps: 300,
    inAmountRaw: solToLamports(0.49),
    inFilledRaw: solToLamports(0.49),
    outAmountRaw: 1_000_000_000n,
    quotedOutRaw: 1_010_000_000n,
    priceImpact: 0.01,
    feeLamports: 100_000n,
    solUsd: 150,
    signature: null,
    error: null,
    ...over,
  };
}

export function sellAttempt(over: Partial<SellTradeInput> = {}): SellTradeInput {
  return {
    status: 'filled',
    reason: 'take_profit',
    attempt: 1,
    slippageBps: 300,
    inAmountRaw: 1_000_000_000n,
    inFilledRaw: 1_000_000_000n,
    outAmountRaw: solToLamports(1.3),
    quotedOutRaw: solToLamports(1.32),
    priceImpact: 0.02,
    feeLamports: 100_000n,
    solUsd: 160,
    signature: null,
    error: null,
    ...over,
  };
}
