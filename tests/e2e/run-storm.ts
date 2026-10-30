// A reconnect storm at full size (result 3, outside Kubernetes): idle chargers on real gateway
// processes, then gateways killed with SIGKILL and started again. Measured from the chargers' side.
// Usage: pnpm storm --chargers 2000 --gateways 3 --kill one --down 1000 --seed 1
// --no-jitter makes every charger wait the full backoff: the baseline that shows what jitter buys.
import { mkdirSync, writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { runStorm, type Percentiles } from './storm-harness.ts';

const { values } = parseArgs({
  options: {
    chargers: { type: 'string', default: '2000' },
    gateways: { type: 'string', default: '3' },
    kill: { type: 'string', default: 'one' },
    down: { type: 'string', default: '1000' },
    seed: { type: 'string', default: '1' },
    'no-jitter': { type: 'boolean', default: false },
  },
});
if (values.kill !== 'one' && values.kill !== 'all') {
  throw new Error(`--kill must be one or all, got "${values.kill}"`);
}
const options = {
  chargers: positiveInteger('chargers', values.chargers),
  gateways: positiveInteger('gateways', values.gateways),
  kill: values.kill,
  downMs: wholeNumber('down', values.down),
  seed: wholeNumber('seed', values.seed),
  jitter: !values['no-jitter'],
} as const;
if (options.kill === 'one' && options.gateways < 2) {
  throw new Error('--kill one needs --gateways 2 or more, so the chargers have somewhere to go');
}

const report = await runStorm(options);
const { coldStart, restart, registry } = report;
const n = (value: number): string => value.toLocaleString('en-US');
const ms = (value: number): string =>
  Number.isFinite(value) ? `${n(Math.round(value))} ms` : 'never';
const spread = (p: Percentiles, unit = ms): string =>
  `p50 ${unit(p.p50)}, p95 ${unit(p.p95)}, p99 ${unit(p.p99)}, max ${unit(p.max)}`;
const everyoneBack =
  restart.affected === restart.expected &&
  restart.reconnected === restart.affected &&
  registry.registered === options.chargers;

console.log(
  [
    `Reconnect storm: seed ${options.seed}, ${n(options.chargers)} idle chargers on ${options.gateways} gateway processes, ` +
      `killing ${options.kill === 'all' ? 'all of them' : 'one'} for ${n(options.downMs)} ms` +
      (options.jitter ? '' : ', with NO jitter'),
    `  cold start  all ${n(options.chargers)} accepted after ${ms(coldStart.allBootedMs)}; per charger ${spread(coldStart.bootMs)}`,
    `  storm       ${n(restart.affected)} chargers lost their connection (the registry put ${n(restart.expected)} on the killed gateways)`,
    `  back        ${n(restart.reconnected)} reconnected, ${n(restart.gaveUp)} gave up; all back ${ms(restart.allBackMs)} after the kill ` +
      `(the killed gateways listened again after ${ms(restart.gatewaysBackMs)})`,
    `  reconnect   ${spread(restart.reconnectMs)}`,
    `  attempts    ${spread(restart.attempts, (value) => n(value))}`,
    `  registry    ${n(registry.registered)} registered: ` +
      Object.entries(registry.byGateway)
        .toSorted(([a], [b]) => a.localeCompare(b))
        .map(([gateway, count]) => `${gateway} ${n(count)}`)
        .join(', '),
  ].join('\n'),
);

mkdirSync('.runs', { recursive: true });
const file =
  `.runs/storm-seed${options.seed}-${options.kill}${options.jitter ? '' : '-nojitter'}-` +
  `${new Date().toISOString().replaceAll(':', '-')}.json`;
writeFileSync(
  file,
  JSON.stringify(
    {
      command:
        `pnpm storm --chargers ${options.chargers} --gateways ${options.gateways} ` +
        `--kill ${options.kill} --down ${options.downMs} --seed ${options.seed}` +
        (options.jitter ? '' : ' --no-jitter'),
      at: new Date().toISOString(),
      node: process.version,
      passed: everyoneBack,
      report,
    },
    null,
    2,
  ),
);
console.log(`  saved       ${file}`);
if (!everyoneBack) process.exitCode = 1;

function positiveInteger(name: string, value: string): number {
  const parsed = wholeNumber(name, value);
  if (parsed < 1) throw new Error(`--${name} must be at least 1, got "${value}"`);
  return parsed;
}

function wholeNumber(name: string, value: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`--${name} must be a whole number, got "${value}"`);
  }
  return parsed;
}
