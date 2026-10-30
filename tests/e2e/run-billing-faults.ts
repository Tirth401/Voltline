// Billing under faults at full size: seeded chargers misbehave against real gateways, and every
// session's bill is checked against what the chargers know they evidenced.
//
//   pnpm faults --sessions 500 --chargers 50 --seed 1            one gateway, in this process
//   pnpm faults --sessions 5000 --chargers 100 --gateways 3 --chaos --seed 1
//                                     three gateway processes, killed with SIGKILL as it runs
//
// Inside the kind cluster, `pnpm kind:faults` runs this file as a Job with --target kubernetes: the
// chargers connect through the gateway Service, and --chaos kills real gateway pods (D-040).
//
// Add --settle-quiet 0 to settle sessions while the chargers run (D-034): a session settles once
// its evidence has been quiet that many ms, and anything later must arrive as a correction.
//
// Add --keep to keep the database schema afterwards (it's always kept when a run fails).
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import { parseArgs } from 'node:util';
import { createTestRedis, deleteKeysWithPrefix } from '@voltline/availability/testing';
import { createPool, type Pool } from '@voltline/db';
import { createTestDatabase } from '@voltline/db/testing';
import { DEFAULT_FAULTS, runFleet, type FleetOptions, type FleetResult } from '@voltline/simulator';
import type { Redis } from 'ioredis';
import { pino } from 'pino';
import { startChaos, startCluster } from './cluster.ts';
import {
  checkBilling,
  forgetChargers,
  makeChargers,
  registerChargers,
  replayAndCompare,
  startSettler,
  startStack,
  validator,
} from './harness.ts';
import {
  KubeClient,
  REPORT_BEGIN,
  REPORT_END,
  startPodChaos,
  waitForGateways,
  type Kill,
} from './kubernetes.ts';

const { values } = parseArgs({
  options: {
    sessions: { type: 'string', default: '500' },
    chargers: { type: 'string', default: '50' },
    gateways: { type: 'string', default: '1' },
    chaos: { type: 'boolean', default: false },
    seed: { type: 'string', default: '1' },
    keep: { type: 'boolean', default: false },
    'settle-quiet': { type: 'string' },
    target: { type: 'string', default: 'local' },
  },
});
if (values.target !== 'local' && values.target !== 'kubernetes') {
  throw new Error(`--target must be local or kubernetes, got "${values.target}"`);
}
const inKubernetes = values.target === 'kubernetes';
const sessions = positiveInteger('sessions', values.sessions);
const chargerCount = positiveInteger('chargers', values.chargers);
const gatewayCount = positiveInteger('gateways', values.gateways);
const seed = Number(values.seed);
if (!Number.isInteger(seed) || seed < 0 || seed >= 2 ** 32) {
  throw new Error(`--seed must be an integer in [0, 2^32), got "${values.seed}"`);
}
const settleQuietMs =
  values['settle-quiet'] === undefined ? undefined : Number(values['settle-quiet']);
if (settleQuietMs !== undefined && !(Number.isInteger(settleQuietMs) && settleQuietMs >= 0)) {
  throw new Error(`--settle-quiet must be a whole number of ms, got "${values['settle-quiet']}"`);
}
if (values.chaos && gatewayCount < 2 && !inKubernetes) {
  throw new Error('--chaos needs --gateways 2 or more, so a charger always has somewhere to go');
}
// Chaos: kill one gateway every 0.5 to 1.5 s, and keep it down for 0.2 to 1 s.
const CHAOS = {
  intervalMs: [500, 1_500] as [number, number],
  downMs: [200, 1_000] as [number, number],
};
// In Kubernetes the same pace, but Kubernetes does the restarting. Each kill is one of three, at
// random: SIGKILL to the gateway process (its container restarts), the pod deleted at once (a new
// one replaces it), or the pod deleted politely, as a deploy does (it drains first).
const POD_CHAOS = { intervalMs: CHAOS.intervalMs, modes: ['crash', 'delete', 'drain'] as const };

const command =
  `pnpm ${inKubernetes ? 'kind:faults' : 'faults'} --sessions ${sessions} --chargers ${chargerCount} --seed ${seed}` +
  (gatewayCount > 1 && !inKubernetes ? ` --gateways ${gatewayCount}` : '') +
  (values.chaos ? ' --chaos' : '') +
  (settleQuietMs === undefined ? '' : ` --settle-quiet ${settleQuietMs}`);
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
  /** Inside Kubernetes: every pod kill, and the rounds skipped because only one gateway was ready. */
  podChaos?: { kills: Kill[]; skipped: number };
  /** Inside Kubernetes: the gateway pods ready before the run started. */
  gatewayPods?: number;
  /** Sessions settled while the chargers ran, and in one last pass after (with --settle-quiet). */
  settled: { whileRunning: number; atTheEnd: number } | undefined;
  /** Tears everything down; keeps the schema if asked. */
  finish(keepDatabase: boolean): Promise<void>;
}

const run = inKubernetes
  ? await runInKubernetes()
  : gatewayCount === 1
    ? await runInProcess()
    : await runOnCluster();
const report = await checkBilling(run.db, run.fleet.sessions, {
  settled: settleQuietMs !== undefined,
});
const replay = await replayAndCompare(
  { db: run.db, redis: run.redis, logger: pino({ level: 'warn' }) },
  chargers,
);

const n = (value: number): string => value.toLocaleString('en-US');
const { faults, energy } = report;
console.log(
  [
    `Billing under faults: seed ${seed}, ${n(sessions)} sessions on ${n(chargerCount)} chargers, ` +
      (inKubernetes
        ? `${String(run.gatewayPods)} gateway pods in Kubernetes`
        : gatewayCount === 1
          ? 'one gateway'
          : `${gatewayCount} gateway processes`),
    `  faults     ${n(faults.offlineSpells)} offline spells (${n(faults.lateStarts)} late StartTransactions), ` +
      `${n(faults.shuffledQueues)} shuffled queues (${n(faults.sessionsWithReadingsAfterStop)} with readings after the stop)`,
    `             ${n(faults.resetsReported + faults.resetsUnreported)} meter resets (${n(faults.resetsUnreported)} unreported), ` +
      `${n(faults.lostResponses)} lost answers, ${n(faults.droppedAfterSend)} connections dropped mid-message`,
    ...(run.podChaos
      ? [
          `  crashes    ${n(run.kills)} gateway pod kills: ` +
            `${n(run.podChaos.kills.filter((kill) => kill.mode === 'crash').length)} SIGKILLs, ` +
            `${n(run.podChaos.kills.filter((kill) => kill.mode === 'delete').length)} pods deleted, ` +
            `${n(run.podChaos.kills.filter((kill) => kill.mode === 'drain').length)} drained ` +
            `(${n(run.podChaos.skipped)} rounds skipped: only one gateway ready); ` +
            `${n(report.reconnects)} times a charger's connection broke and it reconnected`,
        ]
      : gatewayCount > 1
        ? [
            `  crashes    ${n(run.kills)} gateway kills (SIGKILL), ` +
              `${n(report.reconnects)} times a charger's connection broke and it reconnected`,
          ]
        : []),
    ...(report.pendingBoots > 0
      ? [
          `  boots      ${n(report.pendingBoots)} BootNotifications answered Pending (over the budget)`,
        ]
      : []),
    `  sessions   ${n(report.simulated)} simulated, ${n(report.inDatabase)} in the database, ` +
      `${n(report.lost)} lost, ${n(report.invented)} invented`,
    `  bills      ${n(report.discrepancies)} discrepancies (billed ≠ evidenced), ${n(report.problems.length)} sessions with any problem`,
    `  energy     ${n(energy.physicalWh)} Wh flowed, ${n(energy.evidencedWh)} Wh evidenced, ${n(energy.billedWh)} Wh billed`,
    ...(report.settlement && run.settled
      ? [
          `  settled    ${n(report.settlement.settled)} sessions (${n(run.settled.whileRunning)} while the chargers ran, ` +
            `quiet period ${String(settleQuietMs)} ms); ${n(report.settlement.corrections)} corrections on ` +
            `${n(report.settlement.correctedSessions)} sessions, ${n(report.settlement.correctionsWh)} Wh in total`,
        ]
      : []),
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

const saved = JSON.stringify(
  {
    command,
    at: new Date().toISOString(),
    node: process.version,
    target: values.target,
    gateways: inKubernetes ? run.gatewayPods : gatewayCount,
    chaos: values.chaos ? (inKubernetes ? POD_CHAOS : CHAOS) : null,
    kills: run.kills,
    podChaos: run.podChaos ?? null,
    faultProfile: DEFAULT_FAULTS,
    settleQuietMs: settleQuietMs ?? null,
    settled: run.settled ?? null,
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
);
if (inKubernetes) {
  // A Job's files vanish with its pod, so the report goes to the log, where `pnpm kind:faults`
  // picks it up and saves it under .runs/ on the laptop.
  console.log(`${REPORT_BEGIN}\n${saved}\n${REPORT_END}`);
} else {
  mkdirSync('.runs', { recursive: true });
  const file =
    `.runs/billing-faults-seed${seed}-g${gatewayCount}${values.chaos ? '-chaos' : ''}-` +
    `${new Date().toISOString().replaceAll(':', '-')}.json`;
  writeFileSync(file, saved);
  console.log(`  saved      ${file}`);
}

await run.finish(failed || values.keep);
if (values.keep && !failed) console.log(`  kept       schema ${run.schema}`);
if (failed) {
  console.log(
    inKubernetes
      ? `\nFAILED. The chargers' data stays in the cluster's database until the next run.`
      : `\nFAILED. Kept schema ${run.schema} for a post-mortem. Replay a charger's trace with:\n` +
          `  pnpm replay --schema ${run.schema} --charger ${report.problems[0]?.chargePointId ?? 'CP-0001'}`,
  );
  process.exitCode = 1;
}

/** One gateway, inside this process. */
async function runInProcess(): Promise<Run> {
  const stack = await startStack({ logLevel: 'warn' });
  await registerChargers(stack.db.pool, chargers);
  const settler = startSettlerIfAsked(stack.db.pool);
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
    settled: await settler?.stop(),
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
  const settler = startSettlerIfAsked(db.pool);
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
    settled: await settler?.stop(),
    async finish(keepDatabase) {
      await deleteKeysWithPrefix(redis, redisPrefix);
      await redis.quit();
      if (keepDatabase) await db.pool.end();
      else await db.drop();
    },
  };
}

/**
 * Inside the kind cluster, against the gateways as deployed: the chargers connect through the
 * gateway Service, which spreads new connections over the ready pods. The database is the
 * cluster's own, shared with everything else, so the run's chargers start from a clean slate.
 */
async function runInKubernetes(): Promise<Run> {
  const kube = KubeClient.inCluster();
  const gatewayUrl = process.env['GATEWAY_URL'] ?? 'ws://gateway:9220/ocpp';
  const db = createPool();
  const redis = createTestRedis();
  await forgetChargers(db, chargers);
  await registerChargers(db, chargers);
  const gatewayPods = (await waitForGateways(kube)).length;
  const chaos = values.chaos ? startPodChaos({ kube, seed, ...POD_CHAOS }) : undefined;
  const settler = startSettlerIfAsked(db);
  const started = performance.now();
  const fleet = await runFleet(fleetOptions(gatewayUrl));
  const runSeconds = (performance.now() - started) / 1000;
  const podChaos = await chaos?.stop();
  // Let Kubernetes bring every gateway back before checking, so the next run starts whole too.
  // Every answer waited for the frame log (D-023); a moment more lets the last batches land.
  await waitForGateways(kube);
  await sleep(1_000);
  return {
    db,
    redis,
    schema: 'public',
    fleet,
    runSeconds,
    kills: podChaos?.kills.length ?? 0,
    ...(podChaos && { podChaos }),
    gatewayPods,
    settled: await settler?.stop(),
    async finish(keepData) {
      await redis.quit();
      if (!keepData) await forgetChargers(db, chargers);
      await db.end();
    },
  };
}

/** With --settle-quiet, settles sessions in this process while the chargers run (D-034). */
function startSettlerIfAsked(db: Pool) {
  return settleQuietMs === undefined
    ? undefined
    : startSettler(db, { quietMs: settleQuietMs, everyMs: 10 });
}

function positiveInteger(name: string, value: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`--${name} must be a positive integer, got "${value}"`);
  }
  return parsed;
}
