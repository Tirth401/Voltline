/**
 * A reconnect storm (result 3, outside Kubernetes): many idle chargers on several real gateway
 * processes, then one gateway, or all of them, killed with SIGKILL and started again. Every number
 * is measured from the chargers' side.
 */
import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { createTestRedis, deleteKeysWithPrefix } from '@voltline/availability/testing';
import { Prng } from '@voltline/common';
import { createTestDatabase } from '@voltline/db/testing';
import { ConnectionRegistry } from '@voltline/routing';
import { IdleCharger } from '@voltline/simulator';
import { startCluster } from './cluster.ts';
import { makeChargers, registerChargers, validator } from './harness.ts';

export interface StormOptions {
  chargers: number;
  gateways: number;
  seed: number;
  /** 'one' kills the first gateway; 'all' kills every gateway at once. */
  kill: 'one' | 'all';
  /** How long the killed gateways stay down before they start again. */
  downMs: number;
  /** false: every charger waits the full backoff, in step with all the others. Default true. */
  jitter?: boolean;
}

export interface Percentiles {
  p50: number;
  p95: number;
  p99: number;
  max: number;
}

export interface StormReport {
  options: StormOptions;
  /** Every charger started at the same moment. */
  coldStart: {
    /** Per charger: from starting to a gateway accepting its BootNotification. */
    bootMs: Percentiles;
    /** Until the last charger was accepted. */
    allBootedMs: number;
  };
  restart: {
    /** Chargers the registry placed on a killed gateway just before the kill. */
    expected: number;
    /** Chargers that noticed they had lost their connection. */
    affected: number;
    reconnected: number;
    gaveUp: number;
    /** Per charger: from noticing the loss to a gateway accepting its BootNotification again. */
    reconnectMs: Percentiles;
    /** Connection attempts each charger needed. */
    attempts: Percentiles;
    /** From the kill until the killed gateways were listening again. */
    gatewaysBackMs: number;
    /** From the kill until the last affected charger was back. */
    allBackMs: number;
    /** Chargers connected and accepted, sampled every 100 ms from the kill. */
    timeline: number[];
  };
  /** After the storm: where the registry says each charger is. */
  registry: { registered: number; byGateway: Record<string, number> };
}

export async function runStorm(options: StormOptions): Promise<StormReport> {
  const db = await createTestDatabase();
  const redis = createTestRedis();
  const redisPrefix = `voltline-test-${randomUUID()}:`;
  const identities = makeChargers(options.chargers, 'CP-STORM');
  await registerChargers(db.pool, identities);
  const cluster = await startCluster({
    gateways: options.gateways,
    databaseSchema: db.schema,
    redisPrefix,
  });
  const registry = new ConnectionRegistry(redis, redisPrefix);
  const root = new Prng(options.seed);
  const chargers = identities.map(
    ({ chargePointId }) =>
      new IdleCharger({
        gatewayUrls: cluster.urls,
        chargePointId,
        rng: root.fork(chargePointId),
        validator,
        ...(options.jitter === false && { jitter: false }),
      }),
  );
  const owners = async () =>
    Promise.all(chargers.map(async (charger) => registry.owner(charger.chargePointId)));

  try {
    const started = performance.now();
    await Promise.all(chargers.map((charger) => charger.start()));
    const allBootedMs = performance.now() - started;

    const victims = options.kill === 'all' ? cluster.urls.map((_, i) => i) : [0];
    const victimIds = new Set(victims.map((i) => `gw-${i + 1}`));
    const expected = (await owners()).filter((owner) => owner && victimIds.has(owner.gatewayId));

    const timeline: number[] = [];
    const sample = () => timeline.push(chargers.filter((charger) => charger.connected).length);
    const killedAt = performance.now();
    const sampler = setInterval(sample, 100);
    await Promise.all(victims.map((i) => cluster.kill(i)));
    await sleep(options.downMs);
    await Promise.all(victims.map((i) => cluster.restart(i)));
    const gatewaysBackMs = performance.now() - killedAt;
    const deadline = performance.now() + 60_000;
    while (chargers.some((charger) => !charger.connected) && performance.now() < deadline) {
      await sleep(20);
    }
    clearInterval(sampler);
    sample();

    const lost = chargers.flatMap((charger) =>
      charger.reconnects.filter((reconnect) => reconnect.lostAt >= killedAt),
    );
    const back = lost.flatMap((reconnect) =>
      reconnect.bootedAt === undefined ? [] : [reconnect.bootedAt],
    );
    const byGateway: Record<string, number> = {};
    for (const owner of await owners()) {
      if (owner) byGateway[owner.gatewayId] = (byGateway[owner.gatewayId] ?? 0) + 1;
    }
    return {
      options,
      coldStart: {
        bootMs: percentiles(chargers.map((charger) => charger.firstBootMs ?? Infinity)),
        allBootedMs,
      },
      restart: {
        expected: expected.length,
        affected: lost.length,
        reconnected: back.length,
        gaveUp: lost.filter((reconnect) => reconnect.gaveUp).length,
        reconnectMs: percentiles(
          lost.map((reconnect) => (reconnect.bootedAt ?? Infinity) - reconnect.lostAt),
        ),
        attempts: percentiles(lost.map((reconnect) => reconnect.attempts)),
        gatewaysBackMs,
        allBackMs: back.length === 0 ? 0 : Math.max(...back) - killedAt,
        timeline,
      },
      registry: {
        registered: Object.values(byGateway).reduce((sum, count) => sum + count, 0),
        byGateway,
      },
    };
  } finally {
    await Promise.all(chargers.map((charger) => charger.stop()));
    await cluster.stop();
    await deleteKeysWithPrefix(redis, redisPrefix);
    await redis.quit();
    await db.drop();
  }
}

/** Nearest-rank percentiles. Infinity stands for a charger that never made it. */
export function percentiles(values: readonly number[]): Percentiles {
  const sorted = values.toSorted((a, b) => a - b);
  const at = (p: number) => sorted[Math.max(0, Math.ceil((p / 100) * sorted.length) - 1)] ?? 0;
  return { p50: at(50), p95: at(95), p99: at(99), max: sorted.at(-1) ?? 0 };
}
