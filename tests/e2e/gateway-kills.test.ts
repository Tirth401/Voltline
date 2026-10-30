import { randomUUID } from 'node:crypto';
import { createTestRedis, deleteKeysWithPrefix } from '@voltline/availability/testing';
import { createTestDatabase, type TestDatabase } from '@voltline/db/testing';
import { runFleet, type FaultProfile, type FleetResult } from '@voltline/simulator';
import type { Redis } from 'ioredis';
import { pino } from 'pino';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startChaos, startCluster, type Cluster } from './cluster.ts';
import {
  checkBilling,
  makeChargers,
  registerChargers,
  replayAndCompare,
  validator,
  type BillingReport,
} from './harness.ts';

// Milestone 3's exit check, small enough to run every time: three real gateway processes,
// killed with SIGKILL while the chargers are charging. `pnpm faults --gateways 3 --chaos` is the
// full-size version.

const chargers = makeChargers(8, 'CP-KILL');
const SESSIONS = 40;
const SEED = 2027;
const FAULTS: FaultProfile = {
  offline: 0.4,
  lostResponse: 0.1,
  dropAfterSend: 0.03,
  reorder: 0.6,
  meterReset: 0.3,
};

let db: TestDatabase;
let redis: Redis;
let cluster: Cluster;
let fleet: FleetResult;
let kills: number;
let report: BillingReport;
const redisPrefix = `voltline-test-${randomUUID()}:`;

beforeAll(async () => {
  db = await createTestDatabase();
  redis = createTestRedis();
  await registerChargers(db.pool, chargers);
  cluster = await startCluster({ gateways: 3, databaseSchema: db.schema, redisPrefix });
  // Much faster than the full run's chaos, so that this short test sees several kills.
  const chaos = startChaos({ cluster, seed: SEED, intervalMs: [100, 300], downMs: [100, 300] });
  fleet = await runFleet({
    gatewayUrl: cluster.urls,
    chargers,
    sessions: SESSIONS,
    seed: SEED,
    faults: FAULTS,
    validator,
  });
  ({ kills } = await chaos.stop());
  await cluster.stop();
  report = await checkBilling(db.pool, fleet.sessions);
}, 180_000);

afterAll(async () => {
  await deleteKeysWithPrefix(redis, redisPrefix);
  await redis.quit();
  await db.drop();
});

describe(`billing while gateways are killed (seed ${SEED}, ${SESSIONS} sessions, 3 gateways)`, () => {
  it('really killed gateways under the chargers', () => {
    expect(fleet.failures).toEqual([]);
    expect(kills).toBeGreaterThan(0);
    expect(report.reconnects).toBeGreaterThan(0);
  });

  it('bills every session exactly, and loses or invents none', () => {
    expect(report.problems).toEqual([]);
    expect(report).toMatchObject({
      simulated: SESSIONS,
      inDatabase: SESSIONS,
      lost: 0,
      invented: 0,
      discrepancies: 0,
    });
  });

  it('still rebuilds every bill from the recorded frames, kills and all', async () => {
    const source = { db: db.pool, redis, logger: pino({ level: 'silent' }) };
    expect(await replayAndCompare(source, chargers)).toEqual({
      sessions: SESSIONS,
      mismatches: [],
    });
  });
});
