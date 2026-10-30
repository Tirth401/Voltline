import { createTestDatabase, type TestDatabase } from '@voltline/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { authorizeIdTag } from './id-tags.ts';
import type { MeterSample } from './meter-sample.ts';
import { recordMeterValues, startTransaction, stopTransaction } from './sessions.ts';

let db: TestDatabase;
const T0 = Date.parse('2026-01-01T08:00:00Z');
const at = (minute: number): Date => new Date(T0 + minute * 60_000);
const now = at(600);

const energySample = (
  minute: number,
  wh: number,
  extra: Partial<MeterSample> = {},
): MeterSample => ({
  ts: at(minute),
  measurand: 'Energy.Active.Import.Register',
  phase: '',
  location: 'Outlet',
  context: 'Sample.Periodic',
  unit: 'Wh',
  rawValue: String(wh),
  ...extra,
});

beforeAll(async () => {
  db = await createTestDatabase();
  await db.pool.query(`INSERT INTO charge_points (id) VALUES ('CP-1'), ('CP-2')`);
  await db.pool.query(
    `INSERT INTO id_tags (id_tag, status, expires_at) VALUES
       ('TAG-OK', 'Accepted', NULL),
       ('TAG-BUSY', 'Accepted', NULL),
       ('TAG-BLOCKED', 'Blocked', NULL),
       ('TAG-OLD', 'Accepted', '2025-01-01T00:00:00Z')`,
  );
});

afterAll(async () => {
  await db.drop();
});

describe('authorizeIdTag', () => {
  it('matches tags case-insensitively, and reports blocked, expired and unknown tags', async () => {
    expect(await authorizeIdTag(db.pool, 'tag-ok', now)).toEqual({ status: 'Accepted' });
    expect(await authorizeIdTag(db.pool, 'TAG-BLOCKED', now)).toEqual({ status: 'Blocked' });
    expect(await authorizeIdTag(db.pool, 'TAG-OLD', now)).toEqual({
      status: 'Expired',
      expiryDate: '2025-01-01T00:00:00.000Z',
    });
    expect(await authorizeIdTag(db.pool, 'NOBODY', now)).toEqual({ status: 'Invalid' });
  });
});

describe('startTransaction', () => {
  const start = {
    chargePointId: 'CP-1',
    connectorId: 1,
    idTag: 'TAG-OK',
    meterStartWh: 10_000,
    startedAt: at(0),
    now,
  };

  it('starts one session however often, and however concurrently, the same start arrives', async () => {
    const first = await startTransaction(db.pool, start);
    const retries = [
      await startTransaction(db.pool, start),
      ...(await Promise.all([startTransaction(db.pool, start), startTransaction(db.pool, start)])),
    ];
    expect(first).toMatchObject({ created: true, idTagInfo: { status: 'Accepted' } });
    for (const retry of retries) expect(retry).toEqual({ ...first, created: false });

    const { rows } = await db.pool.query<{ sessions: number }>(
      `SELECT count(*)::int AS sessions FROM transactions WHERE charge_point_id = 'CP-1'`,
    );
    expect(rows[0]?.sessions).toBe(1);
  });

  it('records a session with an unknown tag anyway, and says the tag is invalid', async () => {
    const result = await startTransaction(db.pool, {
      ...start,
      connectorId: 2,
      idTag: 'NOBODY',
      startedAt: at(5),
    });
    expect(result).toMatchObject({ created: true, idTagInfo: { status: 'Invalid' } });
  });

  it('answers ConcurrentTx for a tag that is already charging', async () => {
    const busy = { ...start, chargePointId: 'CP-2', idTag: 'TAG-BUSY' };
    await startTransaction(db.pool, { ...busy, connectorId: 1, startedAt: at(1) });
    const second = await startTransaction(db.pool, {
      ...busy,
      connectorId: 2,
      idTag: 'tag-busy',
      startedAt: at(2),
    });
    expect(second).toMatchObject({ created: true, idTagInfo: { status: 'ConcurrentTx' } });
  });
});

describe('meter values and stop', () => {
  const begin = async (
    connectorId: number,
    minute: number,
    meterStartWh: number,
  ): Promise<number> =>
    (
      await startTransaction(db.pool, {
        chargePointId: 'CP-1',
        connectorId,
        idTag: 'NOBODY',
        meterStartWh,
        startedAt: at(minute),
        now,
      })
    ).transactionId;

  it('keeps each reading once, bills from all the evidence, and flags a conflicting second stop', async () => {
    const transactionId = await begin(3, 10, 500);
    const samples = [
      energySample(11, 700),
      energySample(12, 950),
      energySample(12, 7_400, { measurand: 'Power.Active.Import', unit: 'W' }),
    ];
    const meterValues = { chargePointId: 'CP-1', connectorId: 3, transactionId, samples };
    expect(await recordMeterValues(db.pool, meterValues)).toEqual({ inserted: 3 });
    expect(await recordMeterValues(db.pool, meterValues)).toEqual({ inserted: 0 });

    const stop = {
      chargePointId: 'CP-1',
      transactionId,
      meterStopWh: 1_200,
      stoppedAt: at(13),
      reason: 'EVDisconnected',
      samples: [energySample(13, 1_200, { context: 'Transaction.End' })],
    };
    expect(await stopTransaction(db.pool, stop)).toEqual({
      outcome: 'stopped',
      energyWh: 700,
      resetsDetected: 0,
    });
    expect(await stopTransaction(db.pool, stop)).toEqual({
      outcome: 'duplicate',
      energyWh: 700,
      resetsDetected: 0,
      matches: true,
    });
    expect(await stopTransaction(db.pool, { ...stop, meterStopWh: 1_300 })).toMatchObject({
      outcome: 'duplicate',
      matches: false,
    });

    const { rows } = await db.pool.query<{
      state: string;
      needs_review: boolean;
      energy_wh: number;
    }>('SELECT state, needs_review, energy_wh FROM transactions WHERE transaction_id = $1', [
      transactionId,
    ]);
    // The first stop's bill stands; the contradiction is left for a person to look at.
    expect(rows[0]).toEqual({ state: 'stopped', needs_review: true, energy_wh: 700 });
  });

  it('bills a stopped session again when readings arrive late and change the answer', async () => {
    const transactionId = await begin(6, 40, 10_000);
    const stop = await stopTransaction(db.pool, {
      chargePointId: 'CP-1',
      transactionId,
      meterStopWh: 3_000,
      stoppedAt: at(44),
      samples: [],
    });
    // Alone, a stop below the start looks like a reset straight to the final value.
    expect(stop).toEqual({ outcome: 'stopped', energyWh: 3_000, resetsDetected: 1 });

    const late = await recordMeterValues(db.pool, {
      chargePointId: 'CP-1',
      connectorId: 6,
      transactionId,
      samples: [energySample(41, 14_800), energySample(42, 200)],
    });
    expect(late).toEqual({
      inserted: 2,
      rebilled: { previousWh: 3_000, energyWh: 7_800, corrected: false },
    });

    // A reading that doesn't change the bill is stored, and nothing is re-billed.
    const harmless = await recordMeterValues(db.pool, {
      chargePointId: 'CP-1',
      connectorId: 6,
      transactionId,
      samples: [energySample(43, 1_100)],
    });
    expect(harmless).toEqual({ inserted: 1 });
  });

  it('never loses a reading that races its own session stop', async () => {
    // A late reading and the stop arrive at the same moment on different connections. Whichever
    // commits first, the bill must include the reading that reveals the reset.
    for (let round = 0; round < 20; round++) {
      const connectorId = 100 + round;
      const transactionId = await begin(connectorId, 0, 10_000);
      await Promise.all([
        stopTransaction(db.pool, {
          chargePointId: 'CP-1',
          transactionId,
          meterStopWh: 3_000,
          stoppedAt: at(4),
          samples: [],
        }),
        recordMeterValues(db.pool, {
          chargePointId: 'CP-1',
          connectorId,
          transactionId,
          samples: [energySample(1, 14_800), energySample(2, 200)],
        }),
      ]);
      const { rows } = await db.pool.query<{ energy_wh: number }>(
        'SELECT energy_wh FROM transactions WHERE transaction_id = $1',
        [transactionId],
      );
      expect(rows[0]?.energy_wh, `round ${round}`).toBe(7_800);
    }
  });

  it('stitches a meter reset that the readings show', async () => {
    const transactionId = await begin(4, 20, 10_000);
    await recordMeterValues(db.pool, {
      chargePointId: 'CP-1',
      connectorId: 4,
      transactionId,
      samples: [energySample(21, 14_800), energySample(22, 200), energySample(23, 1_100)],
    });
    const result = await stopTransaction(db.pool, {
      chargePointId: 'CP-1',
      transactionId,
      meterStopWh: 3_000,
      stoppedAt: at(24),
      samples: [],
    });
    expect(result).toEqual({ outcome: 'stopped', energyWh: 7_800, resetsDetected: 1 });
  });

  it("refuses to let a charger stop someone else's session, or one that doesn't exist", async () => {
    const transactionId = await begin(5, 30, 0);
    const stop = { transactionId, meterStopWh: 100, stoppedAt: at(31), samples: [] };
    expect(await stopTransaction(db.pool, { ...stop, chargePointId: 'CP-2' })).toEqual({
      outcome: 'unknown',
    });
    expect(
      await stopTransaction(db.pool, { ...stop, chargePointId: 'CP-1', transactionId: 999_999 }),
    ).toEqual({ outcome: 'unknown' });
  });
});
