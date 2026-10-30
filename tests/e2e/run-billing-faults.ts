// Billing under faults at full size: seeded chargers misbehave against real gateways, and every
// session's bill is checked against what the chargers know they evidenced.
//
//   pnpm faults --sessions 500 --chargers 50 --seed 1            one gateway, in this process
//   pnpm faults --sessions 5000 --chargers 100 --gateways 3 --chaos --seed 1
//                                     three gateway processes, killed with SIGKILL as it runs
//
// Add --keep to keep the database schema afterwards (it's always kept when a run fails).
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { createTestRedis, deleteKeysWithPrefix } from '@voltline/availability/testing';
import type { Pool } from '@voltline/db';
import { createTestDatabase } from '@voltline/db/testing';
import { DEFAULT_FAULTS, runFleet, type FleetOptions, type FleetResult } from '@voltline/simulator';
import type { Redis } from 'ioredis';
import { pino } from 'pino';
import { startChaos, startCluster } from './cluster.ts';
import {
  checkBilling,
  makeChargers,
  registerChargers,
  replayAndCompare,
  startStack,
  validator,
} from './harness.ts';

const { values } = parseArgs({
  options: {
    sessions: { type: 'string', default: '500' },
    chargers: { type: 'string', default: '50' },
    gateways: { type: 'string', default: '1' },
    chaos: { type: 'boolean', default: false },
    seed: { type: 'string', default: '1' },
    keep: { type: 'boolean', default: false },
  },
});
const sessions = positiveInteger('sessions', values.sessions);
const chargerCount = positiveInteger('chargers', values.chargers);
const gatewayCount = positiveInteger('gateways', values.gateways);
const seed = Number(values.seed);
if (!Number.isInteger(seed) || seed < 0 || seed >= 2 ** 32) {
  throw new Error(`--seed must be an integer in [0, 2^32), got "${values.seed}"`);
}
if (values.chaos && gatewayCount < 2) {
  throw new Error('--chaos needs --gateways 2 or more, so a charger always has somewhere to go');
}
// Chaos: kill one gateway every 0.5 to 1.5 s, and keep it down for 0.2 to 1 s.
const CHAOS = {
  intervalMs: [500, 1_500] as [number, number],
  downMs: [200, 1_000] as [number, number],
};

const command =
  `pnpm faults --sessions ${sessions} --chargers ${chargerCount} --seed ${seed}` +
  (gatewayCount > 1 ? ` --gateways ${gatewayCount}` : '') +
  (values.chaos ? ' --chaos' : '');
const chargers = makeChargers(chargerCount);
const fleetOptions = (gatewayUrl: FleetOptions['gatewayUrl']): FleetOptions => ({
  gatewayUrl,
  chargers,
  sessions,
  seed,
  faults: DEFAULT_FAULTS,
  validator,
});

interface Run {
  db: Pool;
  redis: Redis;
  schema: string;
  fleet: FleetResult;
  runSeconds: number;
  kills: number;
  /** Tears everything down; keeps the schema if asked. */
  finish(keepDatabase: boolean): Promise<void>;
}

const run = gatewayCount === 1 ? await runInProcess() : await runOnCluster();
const report = await checkBilling(run.db, run.fleet.sessions);
const replay = await replayAndCompare(
  { db: run.db, redis: run.redis, logger: pino({ level: 'warn' }) },
  chargers,
);

const n = (value: number): string => value.toLocaleString('en-US');
const { faults, energy } = report;
console.log(
  [
    `Billing under faults: seed ${seed}, ${n(sessions)} sessions on ${n(chargerCount)} chargers, ` +
      (gatewayCount === 1 ? 'one gateway' : `${gatewayCount} gateway processes`),
    `  faults     ${n(faults.offlineSpells)} offline spells (${n(faults.lateStarts)} late StartTransactions), ` +
      `${n(faults.shuffledQueues)} shuffled queues (${n(faults.sessionsWithReadingsAfterStop)} with readings after the stop)`,
    `             ${n(faults.resetsReported + faults.resetsUnreported)} meter resets (${n(faults.resetsUnreported)} unreported), ` +
      `${n(faults.lostResponses)} lost answers, ${n(faults.droppedAfterSend)} connections dropped mid-message`,
    ...(gatewayCount > 1
      ? [
          `  crashes    ${n(run.kills)} gateway kills (SIGKILL), ` +
            `${n(report.reconnects)} times a charger's connection broke and it reconnected`,
        ]
      : []),
    `  sessions   ${n(report.simulated)} simulated, ${n(report.inDatabase)} in the database, ` +
      `${n(report.lost)} lost, ${n(report.invented)} invented`,
    `  bills      ${n(report.discrepancies)} discrepancies (billed ≠ evidenced), ${n(report.problems.length)} sessions with any problem`,
    `  energy     ${n(energy.physicalWh)} Wh flowed, ${n(energy.evidencedWh)} Wh evidenced, ${n(energy.billedWh)} Wh billed`,
    `  replay     ${n(replay.sessions)} sessions rebuilt from recorded frames, ${n(replay.mismatches.length)} mismatches`,
    `  time       ${run.runSeconds.toFixed(1)} s for the chargers to finish`,
    ...run.fleet.failures.map(
      ({ chargePointId, error }) => `  CRASHED    ${chargePointId}: ${String(error)}`,
    ),
    ...report.problems
      .slice(0, 10)
      .map((p) => `  PROBLEM    ${p.chargePointId} #${p.index}: ${p.problems.join('; ')}`),
    ...replay.mismatches.slice(0, 10).map((m) => `  REPLAY     ${m}`),
  ].join('\n'),
);

const failed =
  run.fleet.failures.length > 0 ||
  report.problems.length > 0 ||
  report.invented > 0 ||
  replay.mismatches.length > 0;

mkdirSync('.runs', { recursive: true });
const file =
  `.runs/billing-faults-seed${seed}-g${gatewayCount}${values.chaos ? '-chaos' : ''}-` +
  `${new Date().toISOString().replaceAll(':', '-')}.json`;
writeFileSync(
  file,
  JSON.stringify(
    {
      command,
      at: new Date().toISOString(),
      node: process.version,
      gateways: gatewayCount,
      chaos: values.chaos ? CHAOS : null,
      kills: run.kills,
      faultProfile: DEFAULT_FAULTS,
      runSeconds: run.runSeconds,
      passed: !failed,
      report,
      replay,
      failures: run.fleet.failures.map(({ chargePointId, error }) => ({
        chargePointId,
        error: String(error),
      })),
    },
    null,
    2,
  ),
);
console.log(`  saved      ${file}`);

await run.finish(failed || values.keep);
if (values.keep && !failed) console.log(`  kept       schema ${run.schema}`);
if (failed) {
  console.log(
    `\nFAILED. Kept schema ${run.schema} for a post-mortem. Replay a charger's trace with:\n` +
      `  pnpm replay --schema ${run.schema} --charger ${report.problems[0]?.chargePointId ?? 'CP-0001'}`,
  );
  process.exitCode = 1;
}

/** One gateway, inside this process. */
async function runInProcess(): Promise<Run> {
  const stack = await startStack({ logLevel: 'warn' });
  await registerChargers(stack.db.pool, chargers);
  const started = performance.now();
  const fleet = await runFleet(fleetOptions(stack.gatewayUrl));
  const runSeconds = (performance.now() - started) / 1000;
  await stack.frameLog.flush();
  return {
    db: stack.db.pool,
    redis: stack.redis,
    schema: stack.db.schema,
    fleet,
    runSeconds,
    kills: 0,
    finish: (keepDatabase) => stack.stop({ keepDatabase }),
  };
}

/** Several gateway processes sharing one schema and one Redis prefix, optionally under chaos. */
async function runOnCluster(): Promise<Run> {
  const db = await createTestDatabase();
  const redis = createTestRedis();
  const redisPrefix = `voltline-test-${randomUUID()}:`;
  await registerChargers(db.pool, chargers);
  const cluster = await startCluster({
    gateways: gatewayCount,
    databaseSchema: db.schema,
    redisPrefix,
  });
  const chaos = values.chaos ? startChaos({ cluster, seed, ...CHAOS }) : undefined;
  const started = performance.now();
  const fleet = await runFleet(fleetOptions(cluster.urls));
  const runSeconds = (performance.now() - started) / 1000;
  const kills = (await chaos?.stop())?.kills ?? 0;
  // A clean stop lets each gateway flush its frame log before the checks read it.
  await cluster.stop();
  return {
    db: db.pool,
    redis,
    schema: db.schema,
    fleet,
    runSeconds,
    kills,
    async finish(keepDatabase) {
      await deleteKeysWithPrefix(redis, redisPrefix);
      await redis.quit();
      if (keepDatabase) await db.pool.end();
      else await db.drop();
    },
  };
}

function positiveInteger(name: string, value: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`--${name} must be a positive integer, got "${value}"`);
  }
  return parsed;
}
