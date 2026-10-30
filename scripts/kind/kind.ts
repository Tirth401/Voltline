/**
 * Shared by the kind scripts: the names of things, and thin wrappers around docker, kind and
 * kubectl. Every kubectl call names the kind cluster's context and namespace, so these scripts can
 * never touch another cluster on this machine.
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const CLUSTER = 'voltline';
export const NAMESPACE = 'voltline';
export const CONTEXT = `kind-${CLUSTER}`;
/** The kind node is itself a Docker container with this name. */
export const NODE = `${CLUSTER}-control-plane`;
export const IMAGE = 'voltline:dev';
/** The other images the manifests run, pinned to exact versions like docker-compose.yml (D-015). */
export const DEPENDENCY_IMAGES = ['timescale/timescaledb:2.31.0-pg17', 'redis:8.10.3-alpine'];
/** Set KUBECTL to use a kubectl other than the first one on your PATH. */
export const KUBECTL = process.env['KUBECTL'] ?? 'kubectl';

interface RunOptions {
  input?: string;
  timeoutMs?: number;
}

/** Runs a command and returns what it printed. Throws with its error output if it fails. */
export function run(command: string, args: readonly string[], options: RunOptions = {}): string {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    input: options.input,
    timeout: options.timeoutMs ?? 600_000,
    maxBuffer: 512 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const output = (result.stderr || result.stdout).trim();
    throw new Error(
      `${command} ${args.join(' ')} failed (exit ${String(result.status)}):\n${output}`,
    );
  }
  return result.stdout;
}

/** Runs a command with its output going straight to the terminal: for steps worth watching. */
export function runVisible(command: string, args: readonly string[]): void {
  const result = spawnSync(command, args, { stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} failed (exit ${String(result.status)})`);
  }
}

export function succeeds(command: string, args: readonly string[]): boolean {
  const result = spawnSync(command, args, { stdio: 'ignore', timeout: 60_000 });
  return result.status === 0;
}

/** kubectl, always in the kind cluster's context and the voltline namespace. */
export function kubectl(args: readonly string[], options: RunOptions = {}): string {
  return run(KUBECTL, ['--context', CONTEXT, '--namespace', NAMESPACE, ...args], options);
}

/**
 * Copies an image from Docker into the kind node. Docker Desktop's image store lists every
 * platform of a multi-platform image (TimescaleDB, say) but keeps only this machine's, and
 * `kind load docker-image` then fails on the missing ones. Saving just this machine's platform to
 * an archive and loading that works everywhere.
 */
export function loadImage(image: string): void {
  const platform = run('docker', ['version', '--format', '{{.Server.Os}}/{{.Server.Arch}}']).trim();
  const dir = mkdtempSync(join(tmpdir(), 'voltline-image-'));
  const archive = join(dir, 'image.tar');
  try {
    run('docker', ['save', '--platform', platform, '--output', archive, image]);
    run('kind', ['load', 'image-archive', archive, '--name', CLUSTER], { timeoutMs: 900_000 });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Whether the kind node already holds this image (by name and tag). */
export function nodeHasImage(image: string): boolean {
  return succeeds('docker', ['exec', NODE, 'crictl', 'inspecti', image]);
}

export function clusterExists(): boolean {
  return run('kind', ['get', 'clusters']).split('\n').includes(CLUSTER);
}

/** Minor versions of kubectl and of the cluster, to warn when they are too far apart. */
export function kubectlSkew(): { client: string; server: string; minorsApart: number } {
  const versions = JSON.parse(
    run(KUBECTL, ['--context', CONTEXT, 'version', '--output', 'json']),
  ) as {
    clientVersion: { gitVersion: string; minor: string };
    serverVersion: { gitVersion: string; minor: string };
  };
  const minor = (value: string) => Number.parseInt(value, 10);
  return {
    client: versions.clientVersion.gitVersion,
    server: versions.serverVersion.gitVersion,
    minorsApart: Math.abs(
      minor(versions.clientVersion.minor) - minor(versions.serverVersion.minor),
    ),
  };
}

export function step(message: string): void {
  console.log(`\n▸ ${message}`);
}
