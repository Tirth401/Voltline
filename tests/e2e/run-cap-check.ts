// The smart-charging check at full size (D-032): cars arrive and leave while chargers refuse
// limits, lose answers and drop offline, and the chargers' own record of what they applied must
// never add up to more than the site's cap. Usefulness is reported next to it (D-016).
// Usage: pnpm cap --changes 1000 --chargers 20 --cap 150000 --seed 1 --gap 10-40
// --gap is the real time between load changes, in ms. The default is far faster than the
// controller's 50 ms tick (a stress test); 150-450 is calm enough to measure usefulness.
// --restart-every 5000 also restarts the controller every 5 s, losing all it believed.
import { mkdirSync, writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { runCapScenario } from './power-harness.ts';

const { values } = parseArgs({
  options: {
    changes: { type: 'string', default: '1000' },
    chargers: { type: 'string', default: '20' },
    cap: { type: 'string', default: '150000' },
    seed: { type: 'string', default: '1' },
    gap: { type: 'string', default: '10-40' },
    'restart-every': { type: 'string' },
  },
});
const gapMs = values.gap.split('-').map((part) => positiveInteger('gap', part));
if (gapMs.length !== 2 || gapMs[0]! > gapMs[1]!) {
  throw new Error(`--gap must look like 10-40, got "${values.gap}"`);
}
const scenario = {
  changes: positiveInteger('changes', values.changes),
  chargers: positiveInteger('chargers', values.chargers),
  capW: positiveInteger('cap', values.cap),
  seed: positiveInteger('seed', values.seed),
  gapMs: gapMs as [number, number],
  ...(values['restart-every'] !== undefined && {
    restartEveryMs: positiveInteger('restart-every', values['restart-every']),
  }),
};

const report = await runCapScenario(scenario);
const { profiles } = report;
const within = report.peakW <= report.capW;
const passed = within && report.unsettled.length === 0 && profiles.errors === 0;
const n = (value: number): string => value.toLocaleString('en-US');
console.log(
  [
    `Smart charging: seed ${scenario.seed}, ${n(scenario.changes)} load changes on ${n(scenario.chargers)} chargers, cap ${n(report.capW)} W, ${values.gap} ms apart`,
    `  load       ${n(report.arrivals)} arrivals, ${n(report.departures)} departures, ` +
      `${n(report.offlineSpells)} offline spells of 0.5 to 2.5 s (a lease lasts 1.5 s)`,
    `  profiles   ${n(profiles.accepted)} accepted, ${n(profiles.refused)} refused, ` +
      `${n(profiles.unanswered)} unanswered, ${n(profiles.notConnected)} to a charger already gone` +
      (profiles.errors > 0 ? `, ${n(profiles.errors)} ERRORS` : ''),
    `  limits     ${n(report.limitChanges)} limit changes applied by the chargers (lease fall-backs included)`,
    `  peak       ${n(report.peakW)} W allowed at once: ${within ? 'within the cap' : 'OVER THE CAP'}`,
    `  useful     ${(report.usefulness * 100).toFixed(1)}% of the spare power handed out, over time`,
    `  settled    ${report.unsettled.length === 0 ? 'every connector at its fair target once the faults stopped' : `not settled: ${report.unsettled.join(', ')}`}`,
    ...(report.controllerRestarts > 0
      ? [
          `  restarts   the controller restarted ${n(report.controllerRestarts)} times, forgetting everything`,
        ]
      : []),
    `  time       ${report.seconds.toFixed(1)} s of load changes`,
  ].join('\n'),
);

mkdirSync('.runs', { recursive: true });
const file = `.runs/cap-seed${scenario.seed}-${new Date().toISOString().replaceAll(':', '-')}.json`;
writeFileSync(
  file,
  JSON.stringify(
    {
      command:
        `pnpm cap --changes ${scenario.changes} --chargers ${scenario.chargers} --cap ${scenario.capW} ` +
        `--seed ${scenario.seed} --gap ${values.gap}` +
        (values['restart-every'] === undefined
          ? ''
          : ` --restart-every ${values['restart-every']}`),
      at: new Date().toISOString(),
      node: process.version,
      passed,
      report,
    },
    null,
    2,
  ),
);
console.log(`  saved      ${file}`);
if (!passed) process.exitCode = 1;

function positiveInteger(name: string, value: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`--${name} must be a positive integer, got "${value}"`);
  }
  return parsed;
}
