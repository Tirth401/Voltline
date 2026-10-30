import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { createServer as createHttpServer } from 'node:http';
import { createServer } from 'node:net';
import { setTimeout as sleep } from 'node:timers/promises';
import { AvailabilityStore } from '@voltline/availability';
import { createTestRedis, deleteKeysWithPrefix } from '@voltline/availability/testing';
import { Prng } from '@voltline/common';
import { createTestDatabase, type TestDatabase } from '@voltline/db/testing';
import { createGateway, LoadBoard, type Gateway } from '@voltline/gateway';
import { DEFAULT_FAULTS, IdleCharger, runFleet } from '@voltline/simulator';
import type { Redis } from 'ioredis';
import { pino } from 'pino';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { checkBilling, makeChargers, registerChargers, startStack, validator } from './harness.ts';

// How a gateway behaves around a restart in Kubernetes: it drains its connections gradually when
// told to stop (D-037), it sheds connections while it holds more than its share (D-039), and it
// answers BootNotification Pending when the cluster's boot budget is spent (D-038).

let db: TestDatabase;
let redis: Redis;
const prefix = `voltline-test-${randomUUID()}:`;
const logger = pino({ level: 'silent' });
const gateways: Gateway[] = [];

beforeAll(async () => {
  db = await createTestDatabase();
  redis = createTestRedis();
});

afterAll(async () => {
  await Promise.allSettled(gateways.map((gateway) => gateway.close()));
  await deleteKeysWithPrefix(redis, prefix);
  await redis.quit();
  await db.drop();
});

async function startGateway(
  port: number,
  extra: Partial<Parameters<typeof createGateway>[0]> = {},
): Promise<{ gateway: Gateway; url: string; base: string }> {
  const gateway = createGateway({
    db: db.pool,
    availability: new AvailabilityStore(redis, prefix),
    validator,
    logger,
    ...extra,
  });
  gateways.push(gateway);
  const address = await gateway.listen(port, '127.0.0.1');
  return {
    gateway,
    url: `ws://127.0.0.1:${address.port}/ocpp`,
    base: `http://127.0.0.1:${address.port}`,
  };
}

async function freePort(): Promise<number> {
  const server = createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  server.close();
  await once(server, 'close');
  if (address === null || typeof address === 'string') throw new Error('no port');
  return address.port;
}

describe('draining at shutdown (D-037)', () => {
  it('turns new chargers away at once, and closes the open connections spread over the window', async () => {
    const chargers = makeChargers(20, 'CP-DRAIN');
    await registerChargers(db.pool, chargers);
    const { gateway, url, base } = await startGateway(0);
    const sockets = await Promise.all(
      chargers.slice(0, 19).map(async ({ chargePointId }) => {
        const ws = new WebSocket(`${url}/${chargePointId}`, ['ocpp1.6']);
        await once(ws, 'open');
        return ws;
      }),
    );
    const closedAt: number[] = [];
    for (const ws of sockets) ws.on('close', () => closedAt.push(performance.now()));
    expect((await fetch(`${base}/readyz`)).status).toBe(200);

    const started = performance.now();
    const closing = gateway.close({ drainMs: 900 });
    // Not ready any more, and a charger arriving now is refused before any WebSocket exists.
    expect((await fetch(`${base}/readyz`)).status).toBe(503);
    const late = new WebSocket(`${url}/${chargers[19]?.chargePointId ?? ''}`, ['ocpp1.6']);
    const [, response] = (await once(late, 'unexpected-response')) as [
      unknown,
      { statusCode: number },
    ];
    expect(response.statusCode).toBe(503);
    await closing;
    // A charger hears its socket close a moment after the gateway does.
    for (let waited = 0; closedAt.length < 19 && waited < 1_000; waited += 10) await sleep(10);

    expect(closedAt).toHaveLength(19);
    const first = Math.min(...closedAt) - started;
    const last = Math.max(...closedAt) - started;
    // Spread over the window, not all at once: one about every 50 ms.
    expect(last - first).toBeGreaterThan(700);
    expect(last).toBeLessThan(1_500);
  });
});

describe('a charger turned away with 503', () => {
  it('tries again elsewhere, and its sessions are billed exactly', async () => {
    // A "gateway" that turns every charger away, as a draining (D-037) or shedding (D-039) one
    // does, next to a real one. The first fault run in kind found the simulator giving up here.
    let refusals = 0;
    const refuser = createHttpServer();
    refuser.on('upgrade', (_request, socket: NodeJS.WritableStream) => {
      refusals += 1;
      socket.end(
        'HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\nContent-Length: 0\r\n\r\n',
      );
    });
    refuser.listen(0, '127.0.0.1');
    await once(refuser, 'listening');
    const address = refuser.address();
    if (address === null || typeof address === 'string') throw new Error('no port');
    try {
      const chargers = makeChargers(4, 'CP-503');
      await registerChargers(db.pool, chargers);
      const { url } = await startGateway(0);
      const fleet = await runFleet({
        gatewayUrl: [`ws://127.0.0.1:${address.port}/ocpp`, url],
        chargers,
        sessions: 8,
        seed: 41,
        faults: DEFAULT_FAULTS,
        validator,
      });
      expect(fleet.failures).toEqual([]);
      expect(refusals).toBeGreaterThan(0);
      const report = await checkBilling(db.pool, fleet.sessions);
      expect(report).toMatchObject({ lost: 0, invented: 0, discrepancies: 0, problems: [] });
    } finally {
      refuser.close();
    }
  });
});

describe('rebalancing (D-039)', () => {
  it('evens out the chargers when an empty gateway joins', async () => {
    const chargers = makeChargers(40, 'CP-BAL');
    await registerChargers(db.pool, chargers);
    const rebalance = {
      board: new LoadBoard(redis, { keyPrefix: prefix, staleMs: 600 }),
      everyMs: 200,
      settings: { slackMin: 2, slackRatio: 0, maxShedPerRound: 5, patienceRounds: 2 },
    };
    const portB = await freePort();
    const a = await startGateway(0, { gatewayId: 'gw-a', rebalance });
    const urlB = `ws://127.0.0.1:${portB}/ocpp`;
    // Every charger may pick either gateway, as behind a Service; B isn't there yet, so all end up on A.
    const root = new Prng(39);
    const idle = chargers.map(
      ({ chargePointId }) =>
        new IdleCharger({
          gatewayUrls: [a.url, urlB],
          chargePointId,
          rng: root.fork(chargePointId),
        }),
    );
    try {
      await Promise.all(idle.map((charger) => charger.start()));
      expect(a.gateway.connections.size).toBe(40);

      const b = await startGateway(portB, { gatewayId: 'gw-b', rebalance });
      const counts = () => [a.gateway.connections.size, b.gateway.connections.size];
      const deadline = performance.now() + 15_000;
      while (b.gateway.connections.size < 18 && performance.now() < deadline) await sleep(50);
      await sleep(1_000); // five more rounds
      const settled = counts();
      // Within the slack of the fair share (20 each), and then nobody moves again.
      for (const count of settled) expect(Math.abs(count - 20)).toBeLessThanOrEqual(2);
      await sleep(1_000);
      expect(counts()).toEqual(settled);
      expect(idle.every((charger) => charger.connected)).toBe(true);
      // The 20 surplus chargers were let go about once each: no churn.
      const shed = await Promise.all(
        [a, b].map(async ({ base }) => {
          const status = (await (await fetch(`${base}/status`)).json()) as {
            shedConnections: number;
          };
          return status.shedConnections;
        }),
      );
      expect(shed[0] ?? 0).toBeGreaterThanOrEqual(18);
      expect((shed[0] ?? 0) + (shed[1] ?? 0)).toBeLessThanOrEqual(22);
    } finally {
      await Promise.all(idle.map((charger) => charger.stop()));
    }
  });
});

describe('the boot budget (D-038)', () => {
  it('makes chargers wait their turn, without changing what a seed makes them do', async () => {
    const chargers = makeChargers(12, 'CP-BUDGET');
    const run = async (bootBudget?: { ratePerSecond: number; burst: number }) => {
      const stack = await startStack(bootBudget && { bootBudget });
      try {
        await registerChargers(stack.db.pool, chargers);
        const fleet = await runFleet({
          gatewayUrl: stack.gatewayUrl,
          chargers,
          sessions: 36,
          seed: 38,
          faults: DEFAULT_FAULTS,
          validator,
        });
        expect(fleet.failures).toEqual([]);
        return await checkBilling(stack.db.pool, fleet.sessions);
      } finally {
        await stack.stop();
      }
    };
    const free = await run();
    // Two boots at once, then four a second: most of the twelve chargers are told to wait.
    const limited = await run({ ratePerSecond: 4, burst: 2 });

    expect(free.pendingBoots).toBe(0);
    expect(limited.pendingBoots).toBeGreaterThanOrEqual(10);
    for (const report of [free, limited]) {
      expect(report).toMatchObject({ lost: 0, invented: 0, discrepancies: 0, problems: [] });
    }
    // Waiting draws nothing from the chargers' seeded streams: same faults, same energy.
    expect(limited.faults).toEqual(free.faults);
    expect(limited.energy).toEqual(free.energy);
  }, 60_000);
});
