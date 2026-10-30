import { setTimeout as sleep } from 'node:timers/promises';
import { createTestDatabase, type TestDatabase } from '@voltline/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { MeterSample } from './meter-sample.ts';
import { recordMeterValues, startTransaction, stopTransaction } from './sessions.ts';
import { settleDueSessions } from './settlement.ts';

let db: TestDatabase;
const T0 = Date.parse('2026-01-01T08:00:00Z');
const at = (minute: number): Date => new Date(T0 + minute * 60_000);

const energySample = (minute: number, wh: number): MeterSample => ({
  ts: at(minute),
  measurand: 'Energy.Active.Import.Register',
  phase: '',
  location: 'Outlet',
  context: 'Sample.Periodic',
  unit: 'Wh',
  rawValue: String(wh),
});

beforeAll(async () => {
  db = await createTestDatabase();
  await db.pool.query(`INSERT INTO charge_points (id) VALUES ('CP-1')`);
  await db.pool.query(`INSERT INTO id_tags (id_tag) VALUES ('TAG-OK')`);
});

afterAll(async () => {
  await db.drop();
});

interface Session {
  transactionId: number;
  connectorId: number;
}

let connectors = 0;

/**
 * A session that started at 10,000 Wh, had its meter reset on the way, and stopped at 3,000 Wh.
 * Its stop alone bills 3,000 Wh; the readings that show the reset bill 7,800 Wh.
 */
async function stoppedSession(): Promise<Session> {
  const connectorId = ++connectors;
  const { transactionId } = await startTransaction(db.pool, {
    chargePointId: 'CP-1',
    connectorId,
    idTag: 'TAG-OK',
    meterStartWh: 10_000,
    startedAt: at(0),
    now: at(60),
  });
  await stopTransaction(db.pool, {
    chargePointId: 'CP-1',
    transactionId,
    meterStopWh: 3_000,
    stoppedAt: at(4),
    samples: [],
  });
  return { transactionId, connectorId };
}

/** The readings a charger sends after the stop, from a shuffled offline queue. */
const lateReadings = ({ transactionId, connectorId }: Session) =>
  recordMeterValues(db.pool, {
    chargePointId: 'CP-1',
    connectorId,
    transactionId,
    samples: [energySample(1, 14_800), energySample(2, 200)],
  });

async function bill({ transactionId }: Session) {
  const { rows } = await db.pool.query<{
    state: string;
    energy_wh: number;
    settled_energy_wh: number | null;
    corrections_wh: number;
    corrections: number;
  }>(
    `SELECT t.state, t.energy_wh, t.settled_energy_wh,
            coalesce(sum(c.delta_wh), 0)::bigint AS corrections_wh, count(c.*)::int AS corrections
       FROM transactions t LEFT JOIN bill_corrections c USING (transaction_id)
      WHERE t.transaction_id = $1
      GROUP BY t.transaction_id`,
    [transactionId],
  );
  return rows[0];
}

describe('settleDueSessions', () => {
  it('settles a stopped session once its evidence has been quiet for long enough', async () => {
    const session = await stoppedSession();
    await settleDueSessions(db.pool, { quietMs: 60_000 });
    expect(await bill(session)).toMatchObject({ state: 'stopped', settled_energy_wh: null });

    await settleDueSessions(db.pool, { quietMs: 0 });
    expect(await bill(session)).toMatchObject({ state: 'settled', settled_energy_wh: 3_000 });
  });

  it('waits while a charger is still sending evidence for a stopped session', async () => {
    const session = await stoppedSession();
    await sleep(300);
    await lateReadings(session); // the stop is 300 ms old, the newest evidence brand new
    await settleDueSessions(db.pool, { quietMs: 200 });
    expect(await bill(session)).toMatchObject({ state: 'stopped', energy_wh: 7_800 });

    await sleep(250);
    await settleDueSessions(db.pool, { quietMs: 200 });
    // It settled with the late readings in it, so nothing needs correcting.
    expect(await bill(session)).toEqual({
      state: 'settled',
      energy_wh: 7_800,
      settled_energy_wh: 7_800,
      corrections_wh: 0,
      corrections: 0,
    });
  });

  it('turns evidence after settlement into a correction, and never edits the settled bill', async () => {
    const session = await stoppedSession();
    await settleDueSessions(db.pool, { quietMs: 0 });
    expect(await lateReadings(session)).toEqual({
      inserted: 2,
      rebilled: { previousWh: 3_000, energyWh: 7_800, corrected: true },
    });
    // A reading that changes nothing is stored, and corrects nothing.
    await recordMeterValues(db.pool, {
      chargePointId: 'CP-1',
      connectorId: session.connectorId,
      transactionId: session.transactionId,
      samples: [energySample(3, 1_100)],
    });
    expect(await bill(session)).toEqual({
      state: 'settled',
      energy_wh: 7_800,
      settled_energy_wh: 3_000,
      corrections_wh: 4_800,
      corrections: 1,
    });
  });

  it('leaves a session that needs review for a person', async () => {
    const session = await stoppedSession();
    await stopTransaction(db.pool, {
      chargePointId: 'CP-1',
      transactionId: session.transactionId,
      meterStopWh: 9_999, // a second, different stop
      stoppedAt: at(4),
      samples: [],
    });
    await settleDueSessions(db.pool, { quietMs: 0 });
    expect(await bill(session)).toMatchObject({ state: 'stopped', settled_energy_wh: null });
  });

  it('keeps settled bill + corrections = the bill, whatever order settlers and readings race in', async () => {
    for (let round = 0; round < 20; round++) {
      const session = await stoppedSession();
      await Promise.all([
        settleDueSessions(db.pool, { quietMs: 0 }),
        lateReadings(session),
        settleDueSessions(db.pool, { quietMs: 0 }),
      ]);
      await settleDueSessions(db.pool, { quietMs: 0 }); // in case the readings held it back
      const after = await bill(session);
      expect(after, `round ${round}`).toMatchObject({ state: 'settled', energy_wh: 7_800 });
      expect((after?.settled_energy_wh ?? 0) + (after?.corrections_wh ?? 0), `round ${round}`).toBe(
        7_800,
      );
      expect(after?.corrections, `round ${round}`).toBeLessThanOrEqual(1);
    }
  });
});
