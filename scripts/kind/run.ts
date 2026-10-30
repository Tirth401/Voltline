// Runs a measurement inside the kind cluster, as a Job, and saves its report on this laptop (D-040).
//
//   pnpm kind:faults --sessions 5000 --chargers 100 --chaos --seed 1    result 1, with pod kills
//   pnpm kind:storm --chargers 2000 --gateways 1 --seed 1                2,000 chargers, one pod
//
// The simulator runs in a pod next to the gateways and reaches them through their Service, like
// any client inside the cluster. Nothing is ever measured through `kubectl port-forward`, which
// would squeeze every connection through one tunnel on the laptop and time that tunnel instead.
//
// --gateways N (storm only) scales the gateway Deployment to N pods for the run, and back to 3
// afterwards. Every other option goes to the run inside the cluster unchanged.
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { setTimeout as sleep } from 'node:timers/promises';
import { REPORT_BEGIN, REPORT_END } from '../../tests/e2e/kubernetes.ts';
import { clusterExists, CONTEXT, IMAGE, KUBECTL, kubectl, NAMESPACE, step } from './kind.ts';

const RUNNERS = {
  faults: 'tests/e2e/run-billing-faults.ts',
  storm: 'tests/e2e/run-storm.ts',
} as const;
const DEFAULT_GATEWAYS = 3;

const [kind, ...rest] = process.argv.slice(2);
if (kind !== 'faults' && kind !== 'storm') {
  throw new Error('usage: node scripts/kind/run.ts faults|storm [options]');
}
const runner = RUNNERS[kind];
if (!clusterExists()) throw new Error('no kind cluster: start one with pnpm kind:up');

const { gateways, passThrough } = takeGateways(rest);
const seed = optionValue(passThrough, '--seed') ?? '1';
const stamp = new Date().toISOString().replaceAll(/[-:]/g, '').replace(/\..*$/, '').toLowerCase();
const jobName = `${kind}-seed${seed}-${stamp}`.slice(0, 63);

// Two runs at once would share charger identities and wipe each other's data.
const active = kubectl([
  'get',
  'jobs',
  '--selector',
  'app.kubernetes.io/name=simulator',
  '--output',
  'jsonpath={range .items[?(@.status.active)]}{.metadata.name}{" "}{end}',
]).trim();
if (active !== '') throw new Error(`another run is still going: ${active}. Wait for it to finish.`);

if (gateways !== undefined) {
  step(`Scaling the gateways to ${gateways}`);
  await scaleGateways(gateways);
}

try {
  step(`Job ${jobName}`);
  kubectl(['create', '--filename', '-'], { input: JSON.stringify(job()) });
  await untilPodStarted();
  const report = await followLog();
  const succeeded = await jobSucceeded();

  mkdirSync('.runs', { recursive: true });
  if (report !== undefined) {
    const file = `.runs/kind-${jobName}.json`;
    writeFileSync(file, report);
    console.log(`  saved      ${file}`);
  } else {
    console.log('  no report in the log: the run stopped before it could write one');
  }
  if (!succeeded) {
    console.log(
      `\nThe Job failed. Its log stays in the cluster: ${KUBECTL} --context ${CONTEXT} -n ${NAMESPACE} logs job/${jobName}`,
    );
    process.exitCode = 1;
  }
} finally {
  if (gateways !== undefined && gateways !== DEFAULT_GATEWAYS) {
    step(`Scaling the gateways back to ${DEFAULT_GATEWAYS}`);
    await scaleGateways(DEFAULT_GATEWAYS);
  }
}

/** The Job: one pod, never retried, so a failed run is reported as it happened. */
function job(): object {
  return {
    apiVersion: 'batch/v1',
    kind: 'Job',
    metadata: {
      name: jobName,
      namespace: NAMESPACE,
      labels: { 'app.kubernetes.io/name': 'simulator', 'app.kubernetes.io/part-of': 'voltline' },
    },
    spec: {
      backoffLimit: 0,
      activeDeadlineSeconds: 3_600,
      ttlSecondsAfterFinished: 7 * 24 * 3_600,
      template: {
        metadata: {
          labels: {
            'app.kubernetes.io/name': 'simulator',
            'app.kubernetes.io/part-of': 'voltline',
          },
        },
        spec: {
          serviceAccountName: 'simulator',
          restartPolicy: 'Never',
          securityContext: {
            runAsNonRoot: true,
            runAsUser: 1000,
            runAsGroup: 1000,
            seccompProfile: { type: 'RuntimeDefault' },
          },
          containers: [
            {
              name: 'simulator',
              image: IMAGE,
              imagePullPolicy: 'Never',
              args: ['node', runner, '--target', 'kubernetes', ...passThrough],
              env: [
                {
                  name: 'DATABASE_URL',
                  valueFrom: { secretKeyRef: { name: 'postgres', key: 'DATABASE_URL' } },
                },
                { name: 'REDIS_URL', value: 'redis://redis:6379' },
                { name: 'GATEWAY_URL', value: 'ws://gateway:9220/ocpp' },
              ],
              resources: {
                requests: { cpu: '1', memory: '512Mi' },
                limits: { memory: '2Gi' },
              },
              securityContext: {
                allowPrivilegeEscalation: false,
                readOnlyRootFilesystem: true,
                capabilities: { drop: ['ALL'] },
              },
            },
          ],
        },
      },
    },
  };
}

async function untilPodStarted(): Promise<void> {
  for (let tries = 0; tries < 600; tries++) {
    const phase = kubectl([
      'get',
      'pods',
      '--selector',
      `job-name=${jobName}`,
      '--output',
      'jsonpath={.items[0].status.phase}',
    ]).trim();
    if (phase === 'Running' || phase === 'Succeeded' || phase === 'Failed') return;
    await sleep(200);
  }
  throw new Error(`the pod of ${jobName} did not start within 2 minutes`);
}

/** Prints the run's log as it comes, and returns the report it printed at the end. */
async function followLog(): Promise<string | undefined> {
  const child = spawn(
    KUBECTL,
    ['--context', CONTEXT, '--namespace', NAMESPACE, 'logs', '--follow', `job/${jobName}`],
    { stdio: ['ignore', 'pipe', 'inherit'] },
  );
  let report: string[] | undefined;
  let found: string | undefined;
  for await (const line of createInterface({ input: child.stdout })) {
    if (line === REPORT_BEGIN) report = [];
    else if (line === REPORT_END && report) {
      found = report.join('\n');
      report = undefined;
    } else if (report) report.push(line);
    else console.log(line);
  }
  return found;
}

async function jobSucceeded(): Promise<boolean> {
  for (let tries = 0; tries < 300; tries++) {
    const status = JSON.parse(kubectl(['get', 'job', jobName, '--output', 'json'])) as {
      status: { succeeded?: number; failed?: number };
    };
    if ((status.status.succeeded ?? 0) > 0) return true;
    if ((status.status.failed ?? 0) > 0) return false;
    await sleep(200);
  }
  return false;
}

async function scaleGateways(replicas: number): Promise<void> {
  kubectl(['scale', 'deployment/gateway', `--replicas=${replicas}`]);
  kubectl(['rollout', 'status', 'deployment/gateway', '--timeout=5m']);
  // rollout status returns once enough pods are ready; scaling down also waits for the extra pods
  // to finish draining, so the run starts with exactly this many.
  for (let tries = 0; tries < 300; tries++) {
    const names = kubectl([
      'get',
      'pods',
      '--selector',
      'app.kubernetes.io/name=gateway',
      '--output',
      'jsonpath={.items[*].metadata.name}',
    ]).trim();
    if (names.split(' ').filter(Boolean).length === replicas) return;
    await sleep(200);
  }
  throw new Error(`gateway pods did not settle at ${replicas}`);
}

function takeGateways(args: readonly string[]): {
  gateways: number | undefined;
  passThrough: string[];
} {
  const passThrough = [...args];
  const at = passThrough.indexOf('--gateways');
  if (at === -1) return { gateways: undefined, passThrough };
  const value = Number(passThrough[at + 1]);
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`--gateways must be a positive integer, got "${String(passThrough[at + 1])}"`);
  }
  passThrough.splice(at, 2);
  return { gateways: value, passThrough };
}

function optionValue(args: readonly string[], name: string): string | undefined {
  const at = args.indexOf(name);
  return at === -1 ? undefined : args[at + 1];
}
