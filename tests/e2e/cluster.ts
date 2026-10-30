/**
 * Several real gateway processes on this machine, which can be killed and restarted on demand,
 * plus a seeded "chaos" loop that does the killing. Milestone 3 runs billing against this.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { createInterface } from 'node:readline';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { Prng } from '@voltline/common';

const GATEWAY_MAIN = fileURLToPath(new URL('../../services/gateway/src/main.ts', import.meta.url));

export interface ClusterOptions {
  gateways: number;
  /** The Postgres schema every gateway uses (from createTestDatabase). */
  databaseSchema: string;
  redisPrefix: string;
}

export interface Cluster {
  /** One WebSocket base URL per gateway, stable across restarts. */
  urls: string[];
  /** Indexes of the gateways currently running. */
  alive(): number[];
  /** SIGKILL: the process gets no chance to close sockets or flush anything. */
  kill(index: number): Promise<void>;
  restart(index: number): Promise<void>;
  /** SIGTERM to every gateway, then wait for them to exit. */
  stop(): Promise<void>;
}

interface Slot {
  name: string;
  port: number;
  child: ChildProcess | undefined;
}

export async function startCluster(options: ClusterOptions): Promise<Cluster> {
  const slots: Slot[] = [];
  for (let i = 0; i < options.gateways; i++) {
    const slot: Slot = { name: `gw-${i + 1}`, port: 0, child: undefined };
    await launch(slot, options);
    slots.push(slot);
  }

  const slotAt = (index: number): Slot => {
    const slot = slots[index];
    if (!slot) throw new Error(`no gateway #${index}`);
    return slot;
  };

  return {
    urls: slots.map((slot) => `ws://127.0.0.1:${slot.port}/ocpp`),
    alive: () => slots.flatMap((slot, i) => (slot.child ? [i] : [])),
    async kill(index) {
      const slot = slotAt(index);
      const child = slot.child;
      if (!child) return;
      slot.child = undefined;
      const exited = once(child, 'exit');
      child.kill('SIGKILL');
      await exited;
    },
    async restart(index) {
      const slot = slotAt(index);
      if (!slot.child) await launch(slot, options);
    },
    async stop() {
      await Promise.all(
        slots.map(async (slot) => {
          const child = slot.child;
          if (!child) return;
          slot.child = undefined;
          const exited = once(child, 'exit');
          child.kill('SIGTERM');
          const timer = setTimeout(() => child.kill('SIGKILL'), 10_000);
          await exited;
          clearTimeout(timer);
        }),
      );
    },
  };
}

/**
 * Starts one gateway and waits for its "listening" log line. The first start takes any free
 * port; restarts reuse it, so chargers find the gateway at the same address again.
 */
async function launch(slot: Slot, options: ClusterOptions): Promise<void> {
  const child = spawn(process.execPath, [GATEWAY_MAIN], {
    env: {
      ...process.env,
      GATEWAY_ID: slot.name,
      HOST: '127.0.0.1',
      PORT: String(slot.port),
      LOG_LEVEL: 'info',
      DATABASE_SCHEMA: options.databaseSchema,
      REDIS_PREFIX: options.redisPrefix,
    },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  slot.child = child;

  const lines = createInterface({ input: child.stdout as NodeJS.ReadableStream });
  const listening = new Promise<number>((resolve, reject) => {
    child.once('exit', (code) => {
      reject(new Error(`${slot.name} exited with code ${String(code)} before listening`));
    });
    lines.on('line', (line) => {
      const entry = parseLogLine(line);
      if (entry?.port !== undefined && entry.msg?.startsWith('gateway listening')) {
        resolve(entry.port);
      }
      // Pass warnings and errors through; the info chatter (connects, disconnects) is dropped.
      if (entry && (entry.level ?? 0) >= 40) {
        console.error(`[${slot.name}] ${entry.msg ?? line}`);
      }
    });
  });
  slot.port = await listening;
}

function parseLogLine(line: string): { level?: number; msg?: string; port?: number } | undefined {
  try {
    return JSON.parse(line) as { level?: number; msg?: string; port?: number };
  } catch {
    return undefined;
  }
}

export interface ChaosOptions {
  cluster: Cluster;
  seed: number;
  /** How long to wait between kills: a random time in [min, max] ms. */
  intervalMs: [number, number];
  /** How long a killed gateway stays down: a random time in [min, max] ms. */
  downMs: [number, number];
}

export interface Chaos {
  /** Stops killing, waits for the current kill to finish, and says how many there were. */
  stop(): Promise<{ kills: number }>;
}

/**
 * Kills a random gateway with SIGKILL every so often and restarts it a little later. It never
 * kills the last running gateway. Which gateway and when come from the seed; what each kill
 * interrupts is down to timing.
 */
export function startChaos(options: ChaosOptions): Chaos {
  const rng = new Prng(options.seed).fork('chaos');
  let stopped = false;
  let kills = 0;
  const loop = (async () => {
    while (!stopped) {
      await sleep(rng.int(...options.intervalMs));
      const alive = options.cluster.alive();
      if (stopped || alive.length <= 1) continue;
      const victim = rng.pick(alive);
      await options.cluster.kill(victim);
      kills += 1;
      await sleep(rng.int(...options.downMs));
      await options.cluster.restart(victim);
    }
  })();
  return {
    async stop() {
      stopped = true;
      await loop;
      return { kills };
    },
  };
}
