import { describe, it, expect } from 'vitest';
import { valuePositions, computeEquity } from '../../../src/risk/equity.js';
import { makeDeps } from '../../helpers/deps.js';
import { FakeJupiter, priced, noRoute } from '../../helpers/fake-jupiter.js';
import { newPosition, buyFill } from '../../helpers/storage.js';
import { solToLamports } from '../../../src/util/units.js';

function setup(fn: ConstructorParameters<typeof FakeJupiter>[0]) {
  const d = makeDeps();
  const jupiter = new FakeJupiter(fn);
  const a = d.storage.openPosition(newPosition(d.clock, { mint: 'A', costBasisLamports: solToLamports(0.5), tokenAmountRaw: 1_000n }), buyFill());
  const b = d.storage.openPosition(newPosition(d.clock, { mint: 'B', costBasisLamports: solToLamports(0.5), tokenAmountRaw: 1_000n }), buyFill());
  return { ...d, jupiter, ids: { a: a.positionId, b: b.positionId } };
}

describe('equity at sellable value', () => {
  it('marks positions with full-size sell quotes, net of sell costs (not mark price)', async () => {
    const { storage, jupiter, config, clock, logger, ids } = setup((req) => priced(req, req.inputMint === 'A' ? 1_000_000 : 400_000));
    const positions = storage.positions.listOpen();
    const v = await valuePositions(positions, { jupiter, storage, config, clock, logger });
    // A: quote 1 SOL → net 1 × 0.99 − 0.0001
    const expectedA = solToLamports(0.99) - 100_000n;
    expect(v.get(ids.a)).toMatchObject({ ok: true, netLamports: expectedA });
    // Sells are quoted at full position size with critical priority.
    expect(jupiter.requests.map((r) => [r.amount, r.priority])).toEqual([
      [1_000n, 'critical'],
      [1_000n, 'critical'],
    ]);
    const e = computeEquity(storage.ledger.balance(), positions, v);
    expect(e.cashLamports).toBe(solToLamports(9));
    expect(e.equityLamports).toBe(solToLamports(9) + expectedA + (solToLamports(0.396) - 100_000n));
    expect(storage.positions.get(ids.a)!.lastQuoteLamports).toBe(expectedA);
  });

  it('values an unquotable position at 0 but still counts its cost basis against the exposure cap', async () => {
    const { storage, jupiter, config, clock, logger, ids } = setup((req) => (req.inputMint === 'B' ? noRoute : priced(req, 1_000_000)));
    const positions = storage.positions.listOpen();
    const v = await valuePositions(positions, { jupiter, storage, config, clock, logger });
    const e = computeEquity(storage.ledger.balance(), positions, v);
    expect(v.get(ids.b)).toMatchObject({ ok: false, consecutiveFailures: 1, unquotable: false });
    expect(e.positionsLamports).toBe(solToLamports(0.99) - 100_000n);
    expect(e.deployedLamports).toBe(solToLamports(0.99) - 100_000n + solToLamports(0.5));
  });

  it('flags "unquotable" after 3 consecutive failed quotes, once, and clears it on recovery', async () => {
    let fail = true;
    const { storage, jupiter, config, clock, logger, ids } = setup((req) => (req.inputMint === 'B' && fail ? new Error('jupiter: timeout') : priced(req, 1_000_000)));
    const pass = async () => {
      const positions = storage.positions.listOpen();
      const v = await valuePositions(positions, { jupiter, storage, config, clock, logger });
      return computeEquity(storage.ledger.balance(), storage.positions.listOpen(), v);
    };
    await pass();
    await pass();
    expect((await pass()).unquotablePositions).toBe(1);
    expect(storage.positions.get(ids.b)!.unquotableSince).not.toBeNull();
    await pass();
    expect(storage.audit.list({ event: 'position_unquotable' })).toHaveLength(1);
    fail = false;
    expect((await pass()).unquotablePositions).toBe(0);
    expect(storage.positions.get(ids.b)!.unquotableSince).toBeNull();
  });
});
