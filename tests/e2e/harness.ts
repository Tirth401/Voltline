/**
 * Shared test harness: a real gateway, Postgres schema and Redis prefix per run, plus the checks
 * that compare what simulated chargers did with what billing stored.
 */
import { randomUUID } from 'node:crypto';
import { AvailabilityStore } from '@voltline/availability';
import { createTestRedis, deleteKeysWithPrefix } from '@voltline/availability/testing';
import type { Pool, Queryable } from '@voltline/db';
import { createTestDatabase, type TestDatabase } from '@voltline/db/testing';
import {
  createGateway,
  loadRecordedCalls,
  PostgresFrameLog,
  replayCalls,
  type Gateway,
} from '@voltline/gateway';
import { createV16Validator } from '@voltline/ocpp';
import type { SessionTruth } from '@voltline/simulator';
import type { Redis } from 'ioredis';
import { pino, type Logger } from 'pino';

export const validator = createV16Validator();

/** A gateway on a random port, over a throwaway Postgres schema and Redis key prefix. */
export interface Stack {
  db: TestDatabase;
  redis: Redis;
  availability: AvailabilityStore;
  frameLog: PostgresFrameLog;
  gateway: Gateway;
  gatewayUrl: string;
  logger: Logger;
  /** Stops everything. `keepDatabase` leaves the schema in place for a post-mortem. */
  stop(options?: { keepDatabase?: boolean }): Promise<void>;
}

export async function startStack(
  options: { pingIntervalMs?: number; logLevel?: string } = {},
): Promise<Stack> {
  const db = await createTestDatabase();
  const redis = createTestRedis();
  const redisPrefix = `voltline-test-${randomUUID()}:`;
  const availability = new AvailabilityStore(redis, redisPrefix);
  const logger = pino({ level: options.logLevel ?? 'silent' });
  const frameLog = new PostgresFrameLog(db.pool, logger);
  const gateway = createGateway({
    db: db.pool,
    availability,
    validator,
    logger,
    frameLog,
    validateResponses: true,
    ...(options.pingIntervalMs !== undefined && { pingIntervalMs: options.pingIntervalMs }),
  });
  const { port } = await gateway.listen(0, '127.0.0.1');
  return {
    db,
    redis,
    availability,
    frameLog,
    gateway,
    gatewayUrl: `ws://127.0.0.1:${port}/ocpp`,
    logger,
    async stop({ keepDatabase = false } = {}) {
      await gateway.close();
      await frameLog.flush();
      await deleteKeysWithPrefix(redis, redisPrefix);
      await redis.quit();
      if (keepDatabase) await db.pool.end();
      else await db.drop();
    },
  };
}

export interface ChargerIdentity {
  chargePointId: string;
  idTag: string;
}

/** CP-0001, CP-0002…, each with a tag of its own, so no two chargers share a card. */
export function makeChargers(count: number, prefix = 'CP'): ChargerIdentity[] {
  return Array.from({ length: count }, (_, i) => {
    const n = String(i + 1).padStart(4, '0');
    return { chargePointId: `${prefix}-${n}`, idTag: `TAG-${prefix}-${n}` };
  });
}

export async function registerChargers(
  db: Queryable,
  chargers: readonly ChargerIdentity[],
): Promise<void> {
  await db.query('INSERT INTO charge_points (id) SELECT unnest($1::text[])', [
    chargers.map((charger) => charger.chargePointId),
  ]);
  await db.query('INSERT INTO id_tags (id_tag) SELECT unnest($1::text[])', [
    chargers.map((charger) => charger.idTag),
  ]);
}

export interface SessionProblem {
  chargePointId: string;
  index: number;
  transactionId: number;
  problems: string[];
}

export interface BillingReport {
  /** Sessions the chargers ran. */
  simulated: number;
  /** Sessions the database holds for those chargers. */
  inDatabase: number;
  /** Simulated, but missing from the database. */
  lost: number;
  /** In the database, but never simulated: a duplicate start that became a second session. */
  invented: number;
  /** Sessions whose bill isn't exactly the evidenced energy. */
  discrepancies: number;
  /** Every session with anything wrong, and what. */
  problems: SessionProblem[];
  energy: { physicalWh: number; evidencedWh: number; billedWh: number };
  /** Times a charger's connection broke under it (a gateway crashed) and it reconnected. */
  reconnects: number;
  /** The faults that actually happened: a run that injected none would prove nothing. */
  faults: {
    offlineSpells: number;
    lateStarts: number;
    shuffledQueues: number;
    sessionsWithReadingsAfterStop: number;
    resetsReported: number;
    resetsUnreported: number;
    lostResponses: number;
    droppedAfterSend: number;
  };
}

/**
 * Compares every simulated session with the database (D-010): it must exist exactly once, under
 * the transactionId the charger was given, billed exactly its evidenced energy, with every reading
 * the charger sent stored exactly once.
 */
export async function checkBilling(
  db: Queryable,
  sessions: readonly SessionTruth[],
): Promise<BillingReport> {
  const chargePointIds = [...new Set(sessions.map((session) => session.chargePointId))];
  const { rows } = await db.query<{
    transaction_id: number;
    charge_point_id: string;
    connector_id: number;
    started_at: Date;
    meter_start_wh: number;
    energy_wh: number | null;
    state: string;
    readings: number | null;
  }>(
    `SELECT t.transaction_id, t.charge_point_id, t.connector_id, t.started_at, t.meter_start_wh,
            t.energy_wh, t.state, r.readings
       FROM transactions t
       LEFT JOIN (SELECT transaction_id, count(*)::int AS readings
                    FROM meter_readings
                   WHERE charge_point_id = ANY($1)
                   GROUP BY transaction_id) r USING (transaction_id)
      WHERE t.charge_point_id = ANY($1)`,
    [chargePointIds],
  );
  const naturalKey = (chargePointId: string, connectorId: number, startedAt: Date, wh: number) =>
    `${chargePointId}|${connectorId}|${startedAt.toISOString()}|${wh}`;
  const byKey = new Map(
    rows.map((row) => [
      naturalKey(row.charge_point_id, row.connector_id, row.started_at, row.meter_start_wh),
      row,
    ]),
  );

  const report: BillingReport = {
    simulated: sessions.length,
    inDatabase: rows.length,
    lost: 0,
    invented: 0,
    discrepancies: 0,
    problems: [],
    energy: { physicalWh: 0, evidencedWh: 0, billedWh: 0 },
    reconnects: 0,
    faults: {
      offlineSpells: 0,
      lateStarts: 0,
      shuffledQueues: 0,
      sessionsWithReadingsAfterStop: 0,
      resetsReported: 0,
      resetsUnreported: 0,
      lostResponses: 0,
      droppedAfterSend: 0,
    },
  };
  const matched = new Set<number>();

  for (const truth of sessions) {
    const problems: string[] = [];
    const row = byKey.get(
      naturalKey(truth.chargePointId, truth.connectorId, truth.startedAt, truth.meterStartWh),
    );
    if (!row) {
      report.lost += 1;
      problems.push('lost: no such session in the database');
    } else {
      matched.add(row.transaction_id);
      report.energy.billedWh += row.energy_wh ?? 0;
      if (row.transaction_id !== truth.transactionId) {
        problems.push(
          `charger holds transactionId ${truth.transactionId}, database ${row.transaction_id}`,
        );
      }
      if (row.energy_wh !== truth.evidencedWh) {
        report.discrepancies += 1;
        problems.push(`billed ${String(row.energy_wh)} Wh, evidenced ${truth.evidencedWh} Wh`);
      }
      if (row.state !== 'stopped') problems.push(`state is ${row.state}`);
      if (row.readings !== truth.samplesSent) {
        problems.push(`${String(row.readings)} readings stored, ${truth.samplesSent} sent`);
      }
    }
    if (new Set(truth.transactionIdsSeen).size !== 1) {
      problems.push(`copies of StartTransaction got ids ${truth.transactionIdsSeen.join(', ')}`);
    }
    if (truth.evidencedWh > truth.physicalWh) problems.push('simulator evidenced more than flowed');
    if (problems.length > 0) {
      report.problems.push({
        chargePointId: truth.chargePointId,
        index: truth.index,
        transactionId: truth.transactionId,
        problems,
      });
    }

    report.energy.physicalWh += truth.physicalWh;
    report.energy.evidencedWh += truth.evidencedWh;
    const { faults } = report;
    if (truth.plan.offline) faults.offlineSpells += 1;
    if (truth.faults.startedOffline) faults.lateStarts += 1;
    if (truth.faults.shuffled) faults.shuffledQueues += 1;
    if (truth.faults.readingsAfterStop > 0) faults.sessionsWithReadingsAfterStop += 1;
    if (truth.faults.reset === 'reported') faults.resetsReported += 1;
    if (truth.faults.reset === 'unreported') faults.resetsUnreported += 1;
    faults.lostResponses += truth.faults.lostResponses;
    faults.droppedAfterSend += truth.faults.droppedAfterSend;
    report.reconnects += truth.faults.reconnects;
  }
  report.invented = rows.filter((row) => !matched.has(row.transaction_id)).length;
  return report;
}

/**
 * Replays every charger's recorded CALLs into a fresh, empty schema and compares the resulting
 * sessions and bills with the originals (D-023). Transaction ids differ between the two databases,
 * so sessions are matched by their natural key.
 */
export interface ReplaySource {
  /** The database the run wrote to. Flush or stop every gateway writing frames first. */
  db: Pool;
  redis: Redis;
  logger: Logger;
}

export async function replayAndCompare(
  source: ReplaySource,
  chargers: readonly ChargerIdentity[],
): Promise<{ sessions: number; mismatches: string[] }> {
  const target = await createTestDatabase();
  const redisPrefix = `voltline-replay-${randomUUID()}:`;
  try {
    await registerChargers(target.pool, chargers);
    const availability = new AvailabilityStore(source.redis, redisPrefix);
    for (const { chargePointId } of chargers) {
      const calls = await loadRecordedCalls(source.db, chargePointId);
      await replayCalls({
        chargePointId,
        calls,
        db: target.pool,
        availability,
        validator,
        logger: source.logger,
      });
    }

    const bills = async (db: Queryable): Promise<Map<string, number | null>> => {
      const { rows } = await db.query<{ key: string; energy_wh: number | null }>(
        `SELECT charge_point_id || '|' || connector_id || '|' || started_at || '|' || meter_start_wh
                  AS key, energy_wh
           FROM transactions`,
      );
      return new Map(rows.map((row) => [row.key, row.energy_wh]));
    };
    const original = await bills(source.db);
    const replayed = await bills(target.pool);
    const mismatches: string[] = [];
    for (const [key, energyWh] of original) {
      if (!replayed.has(key)) mismatches.push(`${key}: missing from the replay`);
      else if (replayed.get(key) !== energyWh) {
        mismatches.push(
          `${key}: billed ${String(energyWh)} Wh, replay ${String(replayed.get(key))} Wh`,
        );
      }
    }
    for (const key of replayed.keys()) {
      if (!original.has(key)) mismatches.push(`${key}: appears only in the replay`);
    }
    return { sessions: replayed.size, mismatches };
  } finally {
    await deleteKeysWithPrefix(source.redis, redisPrefix);
    await target.drop();
  }
}
