/**
 * Checks this machine has what Voltline needs, and says where to get anything missing.
 *
 * Works before `pnpm install`: run `node scripts/prereqs.ts`, or `pnpm prereqs` once pnpm is set up.
 * It imports the ocpp package by relative path for the same reason.
 *
 * Not called "doctor": `pnpm doctor` is pnpm's own built-in command and would shadow the script.
 */
import { execFileSync } from 'node:child_process';
import { checkV16SchemaDir, v16SchemaFileNames } from '../packages/ocpp/src/index.ts';

interface Check {
  /** missing = needed now. later = needed in a later milestone. */
  level: 'ok' | 'missing' | 'later';
  name: string;
  detail: string;
  fix?: string;
}

function outputOf(command: string, args: string[]): string | undefined {
  try {
    const out = execFileSync(command, args, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 20_000,
    });
    return out.trim() || undefined;
  } catch {
    return undefined;
  }
}

const checks: Check[] = [];

const nodeMajor = Number(process.versions.node.split('.')[0]);
checks.push(
  nodeMajor >= 24
    ? { level: 'ok', name: 'Node.js', detail: process.versions.node }
    : {
        level: 'missing',
        name: 'Node.js',
        detail: `${process.versions.node} is too old`,
        fix: 'Install Node 24 LTS from https://nodejs.org',
      },
);

const pnpmVersion = outputOf('pnpm', ['--version']);
checks.push(
  pnpmVersion
    ? { level: 'ok', name: 'pnpm', detail: pnpmVersion }
    : {
        level: 'missing',
        name: 'pnpm',
        detail: 'not on your PATH',
        fix: 'brew install pnpm   (until then, prefix commands with "corepack": corepack pnpm test)',
      },
);

// With the daemon down, `docker info` can still print the template with blank fields.
const [engine, memBytes] = (
  outputOf('docker', ['info', '--format', '{{.ServerVersion}}|{{.MemTotal}}']) ?? ''
).split('|');
if (engine) {
  const gib = (Number(memBytes) / 2 ** 30).toFixed(1);
  checks.push({
    level: 'ok',
    name: 'Docker',
    detail: `engine ${engine}, ${gib} GiB for containers`,
  });
} else {
  const installed = outputOf('docker', ['--version']) !== undefined;
  checks.push({
    level: 'missing',
    name: 'Docker',
    detail: installed ? 'installed, but the engine is not running' : 'not installed',
    fix: installed
      ? 'Start Docker Desktop'
      : 'Install Docker Desktop from https://www.docker.com/products/docker-desktop/',
  });
}

const compose = outputOf('docker', ['compose', 'version', '--short']);
checks.push(
  compose
    ? { level: 'ok', name: 'Docker Compose', detail: compose }
    : {
        level: 'missing',
        name: 'Docker Compose',
        detail: 'not found',
        fix: 'Comes with Docker Desktop',
      },
);

const schemas = checkV16SchemaDir();
const schemaCount = v16SchemaFileNames().length;
checks.push(
  schemas.missing.length === 0
    ? { level: 'ok', name: 'OCPP 1.6 schemas', detail: `all ${schemaCount} files present` }
    : {
        level: 'missing',
        name: 'OCPP 1.6 schemas',
        detail: `${schemas.found} of ${schemaCount} files in packages/ocpp/schemas/v1.6/`,
        fix: 'Download "OCPP 1.6 (all files & errata)" from https://openchargealliance.org/download-ocpp/ (steps: packages/ocpp/schemas/v1.6/README.md)',
      },
);

const kind = outputOf('kind', ['version']);
checks.push(
  kind
    ? { level: 'ok', name: 'kind', detail: kind }
    : {
        level: 'later',
        name: 'kind',
        detail: 'not installed (needed for the week-2 trial run)',
        fix: 'brew install kind',
      },
);

const kubectl = outputOf('kubectl', ['version', '--client']);
checks.push(
  kubectl
    ? { level: 'ok', name: 'kubectl', detail: kubectl.split('\n')[0] ?? kubectl }
    : {
        level: 'later',
        name: 'kubectl',
        detail: 'not installed (needed with kind)',
        fix: 'brew install kubectl',
      },
);

const marks = { ok: '✓', missing: '✗', later: '–' } as const;
for (const check of checks) {
  console.log(`${marks[check.level]} ${check.name.padEnd(17)} ${check.detail}`);
  if (check.level !== 'ok' && check.fix) console.log(`  ${''.padEnd(17)} → ${check.fix}`);
}

if (schemas.missing.length > 0 && schemas.found > 0) {
  console.log(`\nStill missing: ${schemas.missing.join(', ')}`);
}

const blocking = checks.filter((check) => check.level === 'missing').length;
console.log(blocking === 0 ? '\nReady.' : `\n${blocking} thing(s) to fix.`);
process.exitCode = blocking === 0 ? 0 : 1;
