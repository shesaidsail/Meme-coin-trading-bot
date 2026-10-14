import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { FakeClock, HOUR_MS, MINUTE_MS } from '../../src/util/clock.js';
import { solToLamports } from '../../src/util/units.js';
import { tempDb, openStore, newPosition, buyFill } from '../helpers/storage.js';

/**
 * The 48h time stop is stored as an absolute timestamp, not an in-memory
 * timer, so it must survive process restarts unchanged. These tests close and
 * reopen the on-disk database to simulate restarts.
 */
describe('48h time stop across restarts', () => {
  let db: ReturnType<typeof tempDb>;
  beforeEach(() => {
    db = tempDb();
  });
  afterEach(() => db.cleanup());

  it('keeps the original entry time and deadline through restarts', () => {
    const clock = new FakeClock(Date.UTC(2026, 9, 1, 0));
    const t0 = clock.now();

    let store = openStore(db.path, clock);
    store.ledger.initialise(solToLamports(10), t0);
    const { positionId } = store.openPosition(
      newPosition(clock, { enteredAt: t0, timeStopAt: t0 + 48 * HOUR_MS }),
      buyFill(),
    );
    store.close();

    // Restart #1 after 20h: nothing due, entry time unchanged.
    clock.advance(20 * HOUR_MS);
    store = openStore(db.path, clock);
    expect(store.positions.listTimeStopDue(clock.now())).toEqual([]);
    const p = store.positions.get(positionId)!;
    expect(p.enteredAt).toBe(t0);
    expect(p.timeStopAt).toBe(t0 + 48 * HOUR_MS);
    store.close();

    // Restart #2 one minute before the deadline: still not due.
    clock.set(t0 + 48 * HOUR_MS - MINUTE_MS);
    store = openStore(db.path, clock);
    expect(store.positions.listTimeStopDue(clock.now())).toEqual([]);
    store.close();

    // Restart #3 exactly at the deadline: due.
    clock.set(t0 + 48 * HOUR_MS);
    store = openStore(db.path, clock);
    expect(store.positions.listTimeStopDue(clock.now()).map((x) => x.id)).toEqual([positionId]);
    store.close();
  });

  it('a position whose deadline passed while the bot was down is due immediately on startup', () => {
    const clock = new FakeClock(Date.UTC(2026, 9, 1, 0));
    const t0 = clock.now();
    let store = openStore(db.path, clock);
    store.ledger.initialise(solToLamports(10), t0);
    store.openPosition(newPosition(clock, { mint: 'Early', enteredAt: t0 }), buyFill());
    store.openPosition(
      newPosition(clock, { mint: 'Later', enteredAt: t0 + 10 * HOUR_MS, timeStopAt: t0 + 58 * HOUR_MS }),
      buyFill(),
    );
    store.close();

    // Bot was down for 3 days.
    clock.set(t0 + 72 * HOUR_MS);
    store = openStore(db.path, clock);
    expect(store.positions.listTimeStopDue(clock.now()).map((x) => x.mint)).toEqual(['Early', 'Later']);
    store.close();
  });
});
