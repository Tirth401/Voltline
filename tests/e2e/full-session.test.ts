import { randomUUID } from 'node:crypto';
import { AvailabilityStore } from '@voltline/availability';
import { createTestRedis, deleteKeysWithPrefix } from '@voltline/availability/testing';
import { createTestDatabase, type TestDatabase } from '@voltline/db/testing';
import { createGateway, type Gateway } from '@voltline/gateway';
import { createV16Validator } from '@voltline/ocpp';
import { OcppClient, runSession, type SessionGroundTruth } from '@voltline/simulator';
import type { Redis } from 'ioredis';
import { pino } from 'pino';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import WebSocket from 'ws';

// Milestone 1's exit check: a simulated charger runs a whole session through a real gateway into
// real Postgres and Redis, and the stored bill equals what the charger knows it delivered.

const CHARGER = 'CP-E2E-1';
const TAG = 'TAG-E2E-1';
const SEED = 42;
const validator = createV16Validator();
const redisPrefix = `voltline-test-${randomUUID()}:`;

let db: TestDatabase;
let redis: Redis;
let availability: AvailabilityStore;
let gateway: Gateway;
let gatewayUrl: string;

beforeAll(async () => {
  db = await createTestDatabase();
  await db.pool.query('INSERT INTO charge_points (id) VALUES ($1)', [CHARGER]);
  await db.pool.query('INSERT INTO id_tags (id_tag) VALUES ($1)', [TAG]);
  redis = createTestRedis();
  availability = new AvailabilityStore(redis, redisPrefix);
  gateway = createGateway({
    db: db.pool,
    availability,
    validator,
    logger: pino({ level: 'silent' }),
    validateResponses: true,
  });
  const { port } = await gateway.listen(0, '127.0.0.1');
  gatewayUrl = `ws://127.0.0.1:${port}/ocpp`;
});

afterAll(async () => {
  await gateway.close();
  await deleteKeysWithPrefix(redis, redisPrefix);
  await redis.quit();
  await db.drop();
});

const countReadings = async (transactionId: number): Promise<number> => {
  const { rows } = await db.pool.query<{ readings: number }>(
    'SELECT count(*)::int AS readings FROM meter_readings WHERE transaction_id = $1',
    [transactionId],
  );
  return rows[0]?.readings ?? -1;
};

describe('one charger, one full session', () => {
  let truth: SessionGroundTruth;

  beforeAll(async () => {
    truth = await runSession({
      gatewayUrl,
      chargePointId: CHARGER,
      idTag: TAG,
      seed: SEED,
      validator,
    });
  });

  it('bills exactly the energy the charger delivered', async () => {
    const { rows } = await db.pool.query(
      `SELECT charge_point_id, connector_id, id_tag, auth_status, started_at, stopped_at,
              meter_start_wh, meter_stop_wh, energy_wh, resets_detected, state, stop_reason
         FROM transactions WHERE transaction_id = $1`,
      [truth.transactionId],
    );
    expect(rows).toEqual([
      {
        charge_point_id: CHARGER,
        connector_id: 1,
        id_tag: TAG,
        auth_status: 'Accepted',
        started_at: truth.startedAt,
        stopped_at: truth.stoppedAt,
        meter_start_wh: truth.meterStartWh,
        meter_stop_wh: truth.meterStopWh,
        energy_wh: truth.evidencedWh,
        resets_detected: 0,
        state: 'stopped',
        stop_reason: 'EVDisconnected',
      },
    ]);
    // This meter never resets, so everything that flowed is evidenced.
    expect(truth.evidencedWh).toBe(truth.physicalWh);
    expect(truth.physicalWh).toBeGreaterThan(0);
  });

  it('stores every sampled value exactly once', async () => {
    expect(await countReadings(truth.transactionId)).toBe(truth.samplesSent);
  });

  it('records the details the charger gave in BootNotification', async () => {
    const { rows } = await db.pool.query(
      'SELECT vendor, model, firmware_version FROM charge_points WHERE id = $1',
      [CHARGER],
    );
    expect(rows).toEqual([{ vendor: 'Voltline', model: 'SimCharger', firmware_version: '0.1.0' }]);
  });

  it("shows each connector's latest status", async () => {
    const connectors = await availability.connectors(CHARGER);
    expect(connectors.map(({ connectorId, status }) => [connectorId, status])).toEqual([
      [0, 'Available'],
      [1, 'Available'],
    ]);
  });

  it('answers a resent StartTransaction with the same transactionId, and absorbs resent readings and stops', async () => {
    const client = await OcppClient.connect(`${gatewayUrl}/${CHARGER}`, { validator });
    try {
      const again = await client.call('StartTransaction', truth.startRequest);
      expect(again.transactionId).toBe(truth.transactionId);
      for (const request of truth.meterValuesRequests) await client.call('MeterValues', request);
      await client.call('StopTransaction', truth.stopRequest);
    } finally {
      await client.close();
    }

    const { rows } = await db.pool.query<{ sessions: number; energy_wh: number }>(
      `SELECT count(*)::int AS sessions, max(energy_wh) AS energy_wh
         FROM transactions WHERE charge_point_id = $1`,
      [CHARGER],
    );
    expect(rows[0]).toEqual({ sessions: 1, energy_wh: truth.evidencedWh });
    expect(await countReadings(truth.transactionId)).toBe(truth.samplesSent);
  });
});

describe('what the gateway refuses', () => {
  it('turns away a charger that is not registered', async () => {
    await expect(OcppClient.connect(`${gatewayUrl}/CP-STRANGER`)).rejects.toMatchObject({
      name: 'ConnectionRefusedError',
      statusCode: 404,
    });
  });

  it('turns away a client that does not offer the ocpp1.6 subprotocol', async () => {
    const status = await new Promise<number | undefined>((resolve) => {
      const ws = new WebSocket(`${gatewayUrl}/${CHARGER}`, ['ocpp2.0.1']);
      ws.once('unexpected-response', (request, response) => {
        resolve(response.statusCode);
        request.destroy();
      });
      ws.once('open', () => {
        resolve(101);
        ws.close();
      });
      ws.on('error', () => undefined); // the refusal surfaces as unexpected-response
    });
    expect(status).toBe(400);
  });

  it('answers a bad payload, an unknown action and a CSMS-only action with the right CALLERROR', async () => {
    const client = await OcppClient.connect(`${gatewayUrl}/${CHARGER}`);
    try {
      await expect(
        client.callUnchecked('BootNotification', { chargePointVendor: 'Voltline' }),
      ).rejects.toMatchObject({ errorCode: 'OccurenceConstraintViolation' });
      await expect(client.callUnchecked('FlyToTheMoon', {})).rejects.toMatchObject({
        errorCode: 'NotImplemented',
      });
      await expect(client.callUnchecked('Reset', { type: 'Soft' })).rejects.toMatchObject({
        errorCode: 'NotSupported',
      });
    } finally {
      await client.close();
    }
  });
});
