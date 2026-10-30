import { randomUUID } from 'node:crypto';
import type { Redis } from 'ioredis';
import { Redis as RedisClient } from 'ioredis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CommandBus, type CommandRequest, type SupersededNotice } from './command-bus.ts';
import { ConnectionRegistry } from './registry.ts';

const prefix = `voltline-test-${randomUUID()}:`;
let redis: Redis;
let registry: ConnectionRegistry;
const buses: CommandBus[] = [];

const newBus = (timeoutMs = 2_000): CommandBus => {
  const bus = new CommandBus(redis, registry, { keyPrefix: prefix, timeoutMs });
  buses.push(bus);
  return bus;
};

beforeAll(() => {
  redis = new RedisClient(process.env['REDIS_URL'] ?? 'redis://localhost:6379', {
    maxRetriesPerRequest: 1,
  });
  registry = new ConnectionRegistry(redis, prefix);
});

afterAll(async () => {
  await Promise.all(buses.map((bus) => bus.close()));
  const keys = await redis.keys(`${prefix}*`);
  if (keys.length > 0) await redis.del(...keys);
  await redis.quit();
});

describe('ConnectionRegistry', () => {
  it('counts connections, remembers the previous owner, and lets only the owner unregister', async () => {
    const first = await registry.register('CP-1', { gatewayId: 'gw-a', connectionId: 'c1' });
    expect(first).toEqual({ epoch: 1, previous: undefined });

    const second = await registry.register('CP-1', { gatewayId: 'gw-b', connectionId: 'c2' });
    expect(second).toEqual({
      epoch: 2,
      previous: { gatewayId: 'gw-a', connectionId: 'c1', epoch: 1 },
    });

    // The old connection closing late must not erase the new owner.
    expect(await registry.unregister('CP-1', 'c1')).toBe(false);
    expect(await registry.owner('CP-1')).toEqual({
      gatewayId: 'gw-b',
      connectionId: 'c2',
      epoch: 2,
    });
    expect(await registry.unregister('CP-1', 'c2')).toBe(true);
    expect(await registry.owner('CP-1')).toBeUndefined();
  });
});

describe('CommandBus', () => {
  it("delivers a command to the charger's gateway and brings the answer back", async () => {
    const received: CommandRequest[] = [];
    await newBus().serve('gw-serve', {
      command: (request) => {
        received.push(request);
        return Promise.resolve({ status: 'answered', result: { status: 'Accepted' } });
      },
      superseded: () => undefined,
    });
    await registry.register('CP-2', { gatewayId: 'gw-serve', connectionId: 'c3' });

    const outcome = await newBus().send('CP-2', 'TriggerMessage', {
      requestedMessage: 'Heartbeat',
    });
    expect(outcome).toEqual({ status: 'answered', result: { status: 'Accepted' } });
    expect(received).toEqual([
      {
        chargePointId: 'CP-2',
        action: 'TriggerMessage',
        payload: { requestedMessage: 'Heartbeat' },
      },
    ]);
  });

  it('answers not-connected at once when no gateway holds the charger, or its gateway is gone', async () => {
    const bus = newBus(5_000);
    expect(await bus.send('CP-NOWHERE', 'Reset', { type: 'Soft' })).toEqual({
      status: 'not-connected',
    });
    // The registry still names a gateway that crashed before the charger moved.
    await registry.register('CP-3', { gatewayId: 'gw-dead', connectionId: 'c4' });
    const started = Date.now();
    expect(await bus.send('CP-3', 'Reset', { type: 'Soft' })).toEqual({ status: 'not-connected' });
    expect(Date.now() - started).toBeLessThan(1_000); // no waiting out the 5 s timeout
  });

  it('times out when the gateway never answers', async () => {
    await newBus().serve('gw-silent', {
      command: () => new Promise(() => undefined),
      superseded: () => undefined,
    });
    await registry.register('CP-4', { gatewayId: 'gw-silent', connectionId: 'c5' });
    expect(await newBus(200).send('CP-4', 'Reset', { type: 'Soft' })).toEqual({
      status: 'timeout',
    });
  });

  it('passes superseded notices to the old gateway', async () => {
    const notices: SupersededNotice[] = [];
    await newBus().serve('gw-old', {
      command: () => Promise.resolve({ status: 'not-connected' }),
      superseded: (notice) => notices.push(notice),
    });
    await newBus().notifySuperseded('gw-old', { chargePointId: 'CP-5', connectionId: 'c6' });
    await expect.poll(() => notices).toEqual([{ chargePointId: 'CP-5', connectionId: 'c6' }]);
  });
});
