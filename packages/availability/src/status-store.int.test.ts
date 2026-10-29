import { randomUUID } from 'node:crypto';
import type { Redis } from 'ioredis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AvailabilityStore } from './status-store.ts';
import { createTestRedis, deleteKeysWithPrefix } from './testing.ts';

const prefix = `voltline-test-${randomUUID()}:`;
let redis: Redis;
let store: AvailabilityStore;

const T0 = Date.parse('2026-01-01T08:00:00Z');
const at = (minute: number): Date => new Date(T0 + minute * 60_000);

beforeAll(() => {
  redis = createTestRedis();
  store = new AvailabilityStore(redis, prefix);
});

afterAll(async () => {
  await deleteKeysWithPrefix(redis, prefix);
  await redis.quit();
});

describe('AvailabilityStore', () => {
  it('keeps the newest status, and drops an older one that arrives late', async () => {
    const charging = {
      chargePointId: 'CP-1',
      connectorId: 1,
      status: 'Charging',
      errorCode: 'NoError',
      timestamp: at(2),
    };
    expect(await store.record(charging)).toBe(true);
    expect(await store.record({ ...charging, status: 'Preparing', timestamp: at(1) })).toBe(false);
    expect(await store.connectors('CP-1')).toEqual([charging]);
  });

  it('replaces every field, so details of an old status do not linger', async () => {
    const base = { chargePointId: 'CP-2', connectorId: 1, errorCode: 'NoError' };
    await store.record({
      ...base,
      status: 'Faulted',
      errorCode: 'GroundFailure',
      info: 'RCD tripped',
      vendorErrorCode: 'E42',
      timestamp: at(3),
    });
    await store.record({ ...base, status: 'Available', timestamp: at(4) });
    expect(await store.connectors('CP-2')).toEqual([
      { ...base, status: 'Available', timestamp: at(4) },
    ]);
  });

  it('lists every connector of a charger, including 0 for the charger itself', async () => {
    for (const connectorId of [2, 0, 1]) {
      await store.record({
        chargePointId: 'CP-3',
        connectorId,
        status: 'Available',
        errorCode: 'NoError',
        timestamp: at(5),
      });
    }
    const connectors = await store.connectors('CP-3');
    expect(connectors.map((connector) => connector.connectorId)).toEqual([0, 1, 2]);
    expect(await store.connectors('CP-UNKNOWN')).toEqual([]);
  });
});
