// Milestone 2's exit check at full size: seeded chargers misbehave against one real gateway, and
// every session's bill is checked against what the chargers know they evidenced.
// Usage: pnpm faults --sessions 500 --chargers 50 --seed 1 [--keep: keep the database schema]
import { mkdirSync, writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { DEFAULT_FAULTS, runFleet } from '@voltline/simulator';
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
    seed: { type: 'string', default: '1' },
    keep: { type: 'boolean', default: false },
  },
});
const sessions = positiveInteger('sessions', values.sessions);
const chargerCount = positiveInteger('chargers', values.chargers);
const seed = Number(values.seed);
if (!Number.isInteger(seed) || seed < 0 || seed >= 2 ** 32) {
  throw new Error(`--seed must be an integer in [0, 2^32), got "${values.seed}"`);
}

const stack = await startStack({ logLevel: 'warn' });
const chargers = makeChargers(chargerCount);
await registerChargers(stack.db.pool, chargers);

const started = performance.now();
const fleet = await runFleet({
  gatewayUrl: stack.gatewayUrl,
  chargers,
  sessions,
  seed,
  faults: DEFAULT_FAULTS,
  validator,
});
const runSeconds = (performance.now() - started) / 1000;
await stack.frameLog.flush();
const report = await checkBilling(stack.db.pool, fleet.sessions);
const replay = await replayAndCompare(stack, chargers);

const n = (value: number): string => value.toLocaleString('en-US');
const { faults, energy } = report;
console.log(
  [
    `Billing under faults: seed ${seed}, ${n(sessions)} sessions on ${n(chargerCount)} chargers, one gateway`,
    `  faults     ${n(faults.offlineSpells)} offline spells (${n(faults.lateStarts)} late StartTransactions), ` +
      `${n(faults.shuffledQueues)} shuffled queues (${n(faults.sessionsWithReadingsAfterStop)} with readings after the stop)`,
    `             ${n(faults.resetsReported + faults.resetsUnreported)} meter resets (${n(faults.resetsUnreported)} unreported), ` +
      `${n(faults.lostResponses)} lost answers, ${n(faults.droppedAfterSend)} connections dropped mid-message`,
    `  sessions   ${n(report.simulated)} simulated, ${n(report.inDatabase)} in the database, ` +
      `${n(report.lost)} lost, ${n(report.invented)} invented`,
    `  bills      ${n(report.discrepancies)} discrepancies (billed ≠ evidenced), ${n(report.problems.length)} sessions with any problem`,
    `  energy     ${n(energy.physicalWh)} Wh flowed, ${n(energy.evidencedWh)} Wh evidenced, ${n(energy.billedWh)} Wh billed`,
    `  replay     ${n(replay.sessions)} sessions rebuilt from recorded frames, ${n(replay.mismatches.length)} mismatches`,
    `  time       ${runSeconds.toFixed(1)} s for the chargers to finish`,
    ...fleet.failures.map(
      ({ chargePointId, error }) => `  CRASHED    ${chargePointId}: ${String(error)}`,
    ),
    ...report.problems
      .slice(0, 10)
      .map((p) => `  PROBLEM    ${p.chargePointId} #${p.index}: ${p.problems.join('; ')}`),
    ...replay.mismatches.slice(0, 10).map((m) => `  REPLAY     ${m}`),
  ].join('\n'),
);

const failed =
  fleet.failures.length > 0 ||
  report.problems.length > 0 ||
  report.invented > 0 ||
  replay.mismatches.length > 0;

mkdirSync('.runs', { recursive: true });
const file = `.runs/billing-faults-seed${seed}-${new Date().toISOString().replaceAll(':', '-')}.json`;
writeFileSync(
  file,
  JSON.stringify(
    {
      command: `pnpm faults --sessions ${sessions} --chargers ${chargerCount} --seed ${seed}`,
      at: new Date().toISOString(),
      node: process.version,
      faultProfile: DEFAULT_FAULTS,
      runSeconds,
      passed: !failed,
      report,
      replay,
      failures: fleet.failures.map(({ chargePointId, error }) => ({
        chargePointId,
        error: String(error),
      })),
    },
    null,
    2,
  ),
);
console.log(`  saved      ${file}`);

await stack.stop({ keepDatabase: failed || values.keep });
if (values.keep && !failed) console.log(`  kept       schema ${stack.db.schema}`);
if (failed) {
  console.log(
    `\nFAILED. Kept schema ${stack.db.schema} for a post-mortem. Replay a charger's trace with:\n` +
      `  pnpm replay --schema ${stack.db.schema} --charger ${report.problems[0]?.chargePointId ?? 'CP-0001'}`,
  );
  process.exitCode = 1;
}

function positiveInteger(name: string, value: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`--${name} must be a positive integer, got "${value}"`);
  }
  return parsed;
}
