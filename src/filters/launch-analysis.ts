import type { ParsedTx } from '../clients/solana-rpc.js';

export interface LaunchAnalysis {
  firstSlot: number;
  launchSlots: number;
  txCount: number;
  /** True if more launch-window transactions existed than were fetched (result is a lower bound). */
  truncated: boolean;
  /** Tokens acquired in the launch window, per owner wallet (excludes pools and the mint recipient). */
  boughtByOwner: Map<string, bigint>;
  totalBought: bigint;
  /** totalBought / supply */
  launchBuyFraction: number;
  buyerCount: number;
}

/**
 * Sums token acquisitions by wallets in the first `launchSlots` slots.
 *
 * Per transaction, positive balance deltas of the mint are acquisitions,
 * except:
 *  - owners in `excludedOwners` (pool accounts, AMM authorities, burn addresses);
 *  - in a transaction that creates supply (deltas sum > 0, i.e. the initial
 *    mint), the largest recipient, which is the bonding curve or pool
 *    receiving the initial supply, not a buyer.
 * A creator's initial buy in the create transaction is still counted.
 */
export function analyzeLaunch(
  txs: ParsedTx[],
  mint: string,
  supply: bigint,
  excludedOwners: Set<string>,
  launchSlots: number,
  truncated: boolean,
): LaunchAnalysis | null {
  const ok = txs.filter((t) => !t.failed);
  if (ok.length === 0 || supply <= 0n) return null;
  const firstSlot = Math.min(...ok.map((t) => t.slot));
  const window = ok.filter((t) => t.slot < firstSlot + launchSlots);

  const bought = new Map<string, bigint>();
  for (const tx of window) {
    const deltas = new Map<string, bigint>();
    const add = (owner: string | null, v: bigint) => {
      if (!owner) return;
      deltas.set(owner, (deltas.get(owner) ?? 0n) + v);
    };
    for (const b of tx.postTokenBalances) if (b.mint === mint) add(b.owner, b.amount);
    for (const b of tx.preTokenBalances) if (b.mint === mint) add(b.owner, -b.amount);

    let net = 0n;
    for (const v of deltas.values()) net += v;
    if (net > 0n) {
      let top: string | null = null;
      for (const [o, v] of deltas) if (top === null || v > deltas.get(top)!) top = o;
      if (top) deltas.delete(top);
    }
    for (const [owner, v] of deltas) {
      if (v <= 0n || excludedOwners.has(owner)) continue;
      bought.set(owner, (bought.get(owner) ?? 0n) + v);
    }
  }

  let total = 0n;
  for (const v of bought.values()) total += v;
  return {
    firstSlot,
    launchSlots,
    txCount: window.length,
    truncated,
    boughtByOwner: bought,
    totalBought: total,
    launchBuyFraction: Number((total * 1_000_000n) / supply) / 1_000_000,
    buyerCount: bought.size,
  };
}
