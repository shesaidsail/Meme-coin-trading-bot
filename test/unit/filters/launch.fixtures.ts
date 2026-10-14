import type { ParsedTx, SignatureInfo } from '../../../src/clients/solana-rpc.js';
import { ABU_MINT, abuMintInfo } from '../../helpers/filter-ctx.js';

export const SUPPLY = abuMintInfo().supply;
export const part = (f: number) => (SUPPLY * BigInt(Math.round(f * 1e6))) / 1_000_000n;

const bal = (owner: string, amount: bigint) => ({ owner, mint: ABU_MINT, amount });

/**
 * A pump.fun-style launch:
 *  slot 100: create tx mints the supply to the bonding curve; the creator buys 4% in the same tx
 *  slot 101: two snipers buy 10% and 8%
 *  slot 150: a normal buyer (outside the 2-slot window)
 */
export function launchTxs(creator: string): { signatures: SignatureInfo[][]; txs: Record<string, ParsedTx> } {
  const txs: Record<string, ParsedTx> = {
    create: { slot: 100, blockTime: 1, failed: false, logMessages: [], initializedMints: [], feePayer: creator, preTokenBalances: [], postTokenBalances: [bal('Curve', part(0.96)), bal(creator, part(0.04))] },
    snipe1: { slot: 101, blockTime: 1, failed: false, logMessages: [], initializedMints: [], feePayer: 'S1', preTokenBalances: [bal('Curve', part(0.96))], postTokenBalances: [bal('Curve', part(0.86)), bal('S1', part(0.1))] },
    snipe2: { slot: 101, blockTime: 1, failed: false, logMessages: [], initializedMints: [], feePayer: 'S2', preTokenBalances: [bal('Curve', part(0.86))], postTokenBalances: [bal('Curve', part(0.78)), bal('S2', part(0.08))] },
    later: { slot: 150, blockTime: 2, failed: false, logMessages: [], initializedMints: [], feePayer: 'L', preTokenBalances: [bal('Curve', part(0.78))], postTokenBalances: [bal('Curve', part(0.7)), bal('L', part(0.08))] },
  };
  const signatures: SignatureInfo[][] = [
    [
      { signature: 'later', slot: 150, blockTime: 2, err: null },
      { signature: 'snipe2', slot: 101, blockTime: 1, err: null },
      { signature: 'snipe1', slot: 101, blockTime: 1, err: null },
      { signature: 'create', slot: 100, blockTime: 1, err: null },
    ],
  ];
  return { signatures, txs };
}
