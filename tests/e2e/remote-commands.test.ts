import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { createApi, type Api } from '@voltline/api';
import { AvailabilityStore } from '@voltline/availability';
import { createTestRedis, deleteKeysWithPrefix } from '@voltline/availability/testing';
import { Prng } from '@voltline/common';
import { createTestDatabase, type TestDatabase } from '@voltline/db/testing';
import { createGateway, type Gateway } from '@voltline/gateway';
import { CommandBus, ConnectionRegistry } from '@voltline/routing';
import { SimulatedCharger } from '@voltline/simulator';
import type { Redis } from 'ioredis';
import { pino } from 'pino';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import WebSocket from 'ws';
import { registerChargers, validator } from './harness.ts';

// Milestone 3's other exit check: a command sent through the API reaches a charger through
// whichever gateway holds its socket (D-030). Two gateways, one API, all sharing Redis.

const CHARGER = { chargePointId: 'CP-REMOTE-1', idTag: 'TAG-REMOTE-1' };
const MOVER = { chargePointId: 'CP-MOVER-1', idTag: 'TAG-MOVER-1' };
const prefix = `voltline-test-${randomUUID()}:`;
const logger = pino({ level: 'silent' });

let db: TestDatabase;
let redis: Redis;
let registry: ConnectionRegistry;
const buses: CommandBus[] = [];
let gatewayA: Gateway;
let gatewayB: Gateway;
let urlA: string;
let urlB: string;
let api: Api;
let apiUrl: string;
let charger: SimulatedCharger;

const startGateway = async (gatewayId: string): Promise<[Gateway, string]> => {
  const bus = new CommandBus(redis, registry, { keyPrefix: prefix, timeoutMs: 5_000 });
  buses.push(bus);
  const gateway = createGateway({
    db: db.pool,
    availability: new AvailabilityStore(redis, prefix),
    validator,
    logger,
    validateResponses: true,
    gatewayId,
    routing: { registry, bus },
  });
  const { port } = await gateway.listen(0, '127.0.0.1');
  return [gateway, `ws://127.0.0.1:${port}/ocpp`];
};

/** Calls the API and returns the status and parsed JSON body. */
const request = async (method: string, path: string, body?: unknown) => {
  const response = await fetch(`${apiUrl}${path}`, {
    method,
    ...(body !== undefined && {
      body: JSON.stringify(body),
      headers: { 'Content-Type': 'application/json' },
    }),
  });
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
};

beforeAll(async () => {
  db = await createTestDatabase();
  redis = createTestRedis();
  registry = new ConnectionRegistry(redis, prefix);
  await registerChargers(db.pool, [CHARGER, MOVER]);
  [gatewayA, urlA] = await startGateway('gw-a');
  [gatewayB, urlB] = await startGateway('gw-b');
  const apiBus = new CommandBus(redis, registry, { keyPrefix: prefix, timeoutMs: 5_000 });
  buses.push(apiBus);
  api = createApi({
    db: db.pool,
    availability: new AvailabilityStore(redis, prefix),
    registry,
    bus: apiBus,
    logger,
  });
  apiUrl = `http://127.0.0.1:${(await api.listen(0, '127.0.0.1')).port}`;

  // The charger knows only gateway B. Each simulated minute takes 100 ms of real time, so a
  // session is still running when the test sends RemoteStopTransaction.
  charger = new SimulatedCharger({
    gatewayUrl: urlB,
    ...CHARGER,
    rng: new Prng(5).fork(CHARGER.chargePointId),
    validator,
    realMsPerMinute: 100,
  });
  await charger.serve();
  // Registration in Redis happens just after the socket opens.
  await vi.waitFor(async () => {
    expect(await registry.owner(CHARGER.chargePointId)).toMatchObject({ gatewayId: 'gw-b' });
  });
}, 60_000);

afterAll(async () => {
  await api.close();
  await gatewayA.close();
  await gatewayB.close();
  await Promise.all(buses.map((bus) => bus.close()));
  await deleteKeysWithPrefix(redis, prefix);
  await redis.quit();
  await db.drop();
});

describe('commands through the API', () => {
  it('shows which gateway holds the charger', async () => {
    const { status, body } = await request('GET', `/chargers/${CHARGER.chargePointId}`);
    expect(status).toBe(200);
    expect(body).toMatchObject({
      chargePointId: CHARGER.chargePointId,
      model: 'SimCharger',
      connection: { gatewayId: 'gw-b' },
      connectors: [
        { connectorId: 0, status: 'Available' },
        { connectorId: 1, status: 'Available' },
      ],
    });
  });

  it('reaches the charger on gateway B and brings its answer back', async () => {
    const { status, body } = await request(
      'POST',
      `/chargers/${CHARGER.chargePointId}/commands/TriggerMessage`,
      { requestedMessage: 'Heartbeat' },
    );
    expect(status).toBe(200);
    expect(body).toEqual({ status: 'answered', result: { status: 'Accepted' } });
  });

  it('turns away commands that cannot or must not be delivered', async () => {
    const cases: [path: string, payload: unknown, status: number, outcome: string][] = [
      ['/chargers/CP-NOBODY/commands/Reset', { type: 'Soft' }, 409, 'not-connected'],
      [`/chargers/${CHARGER.chargePointId}/commands/Authorize`, { idTag: 'X' }, 400, 'invalid'],
      [`/chargers/${CHARGER.chargePointId}/commands/RemoteStartTransaction`, {}, 400, 'invalid'],
      [`/chargers/${CHARGER.chargePointId}/commands/Reset`, { type: 'Soft' }, 502, 'charger-error'],
    ];
    for (const [path, payload, expectedStatus, outcome] of cases) {
      const { status, body } = await request('POST', path, payload);
      expect({ path, status, outcome: body['status'] }).toEqual({
        path,
        status: expectedStatus,
        outcome,
      });
    }
  });

  it('leaves charging limits to the charging controller', async () => {
    for (const action of ['SetChargingProfile', 'ClearChargingProfile']) {
      const { status, body } = await request(
        'POST',
        `/chargers/${CHARGER.chargePointId}/commands/${action}`,
        {},
      );
      expect({ action, status, error: body['error'] }).toEqual({
        action,
        status: 403,
        error: `${action} is sent only by the charging controller (D-032)`,
      });
    }
  });

  it('starts and stops a session remotely, and bills it exactly', async () => {
    const started = await request(
      'POST',
      `/chargers/${CHARGER.chargePointId}/commands/RemoteStartTransaction`,
      { connectorId: 1, idTag: CHARGER.idTag },
    );
    expect(started).toEqual({
      status: 200,
      body: { status: 'answered', result: { status: 'Accepted' } },
    });

    // Wait until the charger's StartTransaction has created the session.
    let transactionId = 0;
    await expect
      .poll(async () => {
        const { body } = await request('GET', `/chargers/${CHARGER.chargePointId}/sessions`);
        const sessions = body as unknown as { transactionId: number; state: string }[];
        transactionId = sessions.find((session) => session.state === 'active')?.transactionId ?? 0;
        return transactionId;
      })
      .toBeGreaterThan(0);

    const stopped = await request(
      'POST',
      `/chargers/${CHARGER.chargePointId}/commands/RemoteStopTransaction`,
      { transactionId },
    );
    expect(stopped.body).toEqual({ status: 'answered', result: { status: 'Accepted' } });

    const [truth] = await charger.finish();
    expect(truth?.stopRequest.reason).toBe('Remote');
    // Stopped early: fewer readings than the planned minutes.
    expect(truth?.meterValuesRequests.length).toBeLessThan(truth?.plan.minutes ?? 0);
    const { body: session } = await request('GET', `/sessions/${transactionId}`);
    expect(session).toMatchObject({
      transactionId,
      state: 'stopped',
      stopReason: 'Remote',
      energyWh: truth?.evidencedWh,
    });
  });
});

describe('a charger moving between gateways', () => {
  it('makes the old gateway close its stale socket', async () => {
    const onA = new WebSocket(`${urlA}/${MOVER.chargePointId}`, ['ocpp1.6']);
    await once(onA, 'open');
    await expect
      .poll(() => registry.owner(MOVER.chargePointId))
      .toMatchObject({
        gatewayId: 'gw-a',
        epoch: 1,
      });

    // The charger reconnects to B without closing its socket on A, as after a network blip.
    const closedOnA = once(onA, 'close');
    const onB = new WebSocket(`${urlB}/${MOVER.chargePointId}`, ['ocpp1.6']);
    await once(onB, 'open');
    const [code, reason] = (await closedOnA) as [number, Buffer];
    expect([code, reason.toString()]).toEqual([
      1000,
      'replaced by a newer connection on another gateway',
    ]);
    expect(await registry.owner(MOVER.chargePointId)).toMatchObject({
      gatewayId: 'gw-b',
      epoch: 2,
    });
    onB.close();
    await once(onB, 'close');
  });
});
