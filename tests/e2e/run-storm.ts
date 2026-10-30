// A reconnect storm at full size (result 3, outside Kubernetes): idle chargers on real gateway
// processes, then gateways killed with SIGKILL and started again. Measured from the chargers' side.
// Usage: pnpm storm --chargers 2000 --gateways 3 --kill one --down 1000 --seed 1
// --no-jitter makes every charger wait the full backoff: the baseline that shows what jitter buys.
//
// Inside the kind cluster, `pnpm kind:storm` runs this file as a Job with --target kubernetes: the
// chargers connect through the gateway Service, --kill one|all kills gateway pods (--kill-mode
// crash or delete), and --kill none only starts them and watches (the kind trial). --hold says how
// long to keep watching afterwards, in ms.
import { mkdirSync, writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { REPORT_BEGIN, REPORT_END } from './kubernetes.ts';
import { runStorm, type Percentiles } from './storm-harness.ts';
import { runStormInKubernetes, type KubeStormReport } from './storm-kubernetes.ts';

const { values } = parseArgs({
  options: {
    chargers: { type: 'string', default: '2000' },
    gateways: { type: 'string', default: '3' },
    kill: { type: 'string', default: 'one' },
    down: { type: 'string', default: '1000' },
    seed: { type: 'string', default: '1' },
    'no-jitter': { type: 'boolean', default: false },
    target: { type: 'string', default: 'local' },
    'kill-mode': { type: 'string', default: 'crash' },
    hold: { type: 'string', default: '10000' },
  },
});
const n = (value: number): string => value.toLocaleString('en-US');
const ms = (value: number): string =>
  Number.isFinite(value) ? `${n(Math.round(value))} ms` : 'never';
const spread = (p: Percentiles, unit = ms): string =>
  `p50 ${unit(p.p50)}, p95 ${unit(p.p95)}, p99 ${unit(p.p99)}, max ${unit(p.max)}`;

if (values.target === 'kubernetes') await stormInKubernetes();
else if (values.target === 'local') await stormLocally();
else throw new Error(`--target must be local or kubernetes, got "${values.target}"`);

/** Gateway processes on this machine, killed with SIGKILL (D-035). */
async function stormLocally(): Promise<void> {
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
}

/** The same storm inside the kind cluster, against the gateway pods as deployed. */
async function stormInKubernetes(): Promise<void> {
  if (values.kill !== 'none' && values.kill !== 'one' && values.kill !== 'all') {
    throw new Error(`--kill must be none, one or all, got "${values.kill}"`);
  }
  const killMode = values['kill-mode'];
  if (killMode !== 'crash' && killMode !== 'delete' && killMode !== 'drain') {
    throw new Error(`--kill-mode must be crash, delete or drain, got "${killMode}"`);
  }
  const options = {
    chargers: positiveInteger('chargers', values.chargers),
    seed: wholeNumber('seed', values.seed),
    kill: values.kill,
    killMode,
    holdMs: wholeNumber('hold', values.hold),
    jitter: !values['no-jitter'],
    gatewayUrl: process.env['GATEWAY_URL'] ?? 'ws://gateway:9220/ocpp',
  } as const;
  const report: KubeStormReport = await runStormInKubernetes(options);
  const { coldStart, restart, hold, registry } = report;
  const lastSpread = hold.spread.at(-1)?.byPod ?? {};
  const counts = (byPod: Record<string, number>) =>
    Object.entries(byPod)
      .toSorted(([a], [b]) => a.localeCompare(b))
      .map(([pod, count]) => `${pod.replace(/^gateway-[a-z0-9]+-/, '')} ${n(count)}`)
      .join(', ');
  const passed =
    registry.registered === options.chargers &&
    (report.registryCheck?.wrong.length ?? 0) === 0 &&
    hold.lostDuring === 0 &&
    (!restart ||
      (restart.affected === restart.expected &&
        restart.reconnected === restart.affected &&
        restart.gaveUp === 0));
  console.log(
    [
      `Reconnect storm in Kubernetes: seed ${options.seed}, ${n(options.chargers)} idle chargers on ` +
        `${report.gatewayPods} gateway pods` +
        (options.kill === 'none' ? '' : `, killing ${options.kill} (${options.killMode})`) +
        (options.jitter ? '' : ', with NO jitter'),
      `  cold start  all ${n(options.chargers)} accepted after ${ms(coldStart.allBootedMs)}; ` +
        `per charger ${spread(coldStart.bootMs)}; ${n(coldStart.pendingBoots)} boots answered Pending`,
      `  gateways    ` +
        coldStart.gateways
          .map(
            (gateway) =>
              `${gateway.pod.replace(/^gateway-[a-z0-9]+-/, '')}: ${n(gateway.connections)} chargers, ` +
              `${(gateway.rssBytes / 2 ** 20).toFixed(0)} MiB`,
          )
          .join('; '),
      ...(restart
        ? [
            `  storm       ${n(restart.affected)} chargers lost their connection ` +
              `(${restart.victims.join(', ')} held ${n(restart.expected)}; ` +
              `${n(restart.alreadyReconnecting)} of them were already reconnecting)`,
            `  back        ${n(restart.reconnected)} reconnected, ${n(restart.gaveUp)} gave up; ` +
              `all back ${ms(restart.allBackMs)} after the kill; ${n(restart.pendingBoots)} boots answered Pending; ` +
              `close codes ${Object.entries(restart.closeCodes)
                .map(([code, count]) => `${code}: ${n(count)}`)
                .join(', ')}`,
            `  reconnect   ${spread(restart.reconnectMs)}`,
            `  attempts    ${spread(restart.attempts, (value) => n(value))}`,
            `  rebalanced  ${n(restart.rebalanced)} connections moved afterwards to even out the gateways`,
          ]
        : []),
      `  hold        ${n(hold.lostDuring)} connections lost while watching for ${ms(options.holdMs)}; ` +
        `chargers per pod at the end: ${counts(lastSpread)}`,
      ...(report.registryCheck
        ? [
            `  registry    before the kill, ${n(report.registryCheck.wrong.length)} of ${n(report.registryCheck.checked)} ` +
              `chargers were not where the registry said` +
              report.registryCheck.wrong
                .slice(0, 5)
                .map(
                  (entry) =>
                    `\n              ${entry.chargePointId}: registry ${entry.registry ?? 'none'}, actually ${entry.actual ?? 'none'}`,
                )
                .join(''),
          ]
        : []),
      `  registry    ${n(registry.registered)} registered`,
    ].join('\n'),
  );
  const command =
    `pnpm kind:storm --chargers ${options.chargers} --kill ${options.kill}` +
    (options.kill === 'none' ? '' : ` --kill-mode ${options.killMode}`) +
    ` --hold ${options.holdMs} --seed ${options.seed}` +
    (options.jitter ? '' : ' --no-jitter');
  const saved = JSON.stringify(
    { command, at: new Date().toISOString(), node: process.version, passed, report },
    null,
    2,
  );
  console.log(`${REPORT_BEGIN}\n${saved}\n${REPORT_END}`);
  if (!passed) process.exitCode = 1;
}

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
