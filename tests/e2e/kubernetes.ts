/**
 * Just enough of the Kubernetes API for the runs that happen inside the cluster: find the gateway
 * pods, delete one, or SIGKILL the process inside one, plus a seeded chaos loop that does the
 * killing. It talks to the API server with the pod's own service account, which the `simulator`
 * Role allows to do exactly these things and nothing more (deploy/k8s/simulator-rbac.yaml, D-040).
 */
import { readFileSync } from 'node:fs';
import { request } from 'node:https';
import { setTimeout as sleep } from 'node:timers/promises';
import { Prng } from '@voltline/common';
import WebSocket from 'ws';

const SERVICE_ACCOUNT = '/var/run/secrets/kubernetes.io/serviceaccount';

/**
 * A run inside the cluster prints its report to its log between these lines; the script on the
 * laptop that started it cuts the report out and saves it under .runs/. A Job's own files vanish
 * with its pod.
 */
export const REPORT_BEGIN = '----- voltline report begin -----';
export const REPORT_END = '----- voltline report end -----';

export interface Pod {
  name: string;
  ip: string | undefined;
  ready: boolean;
  /** Being deleted. */
  terminating: boolean;
  /** How many times its containers have been restarted. */
  restarts: number;
}

interface PodObject {
  metadata: { name: string; deletionTimestamp?: string };
  status?: {
    podIP?: string;
    conditions?: { type: string; status: string }[];
    containerStatuses?: { restartCount: number }[];
  };
}

export class KubeClient {
  readonly namespace: string;
  readonly #server: URL;
  readonly #token: string;
  readonly #ca: Buffer;

  constructor(options: { server: string; token: string; ca: Buffer; namespace: string }) {
    this.#server = new URL(options.server);
    this.#token = options.token;
    this.#ca = options.ca;
    this.namespace = options.namespace;
  }

  /** The API server and credentials every pod gets from Kubernetes. */
  static inCluster(): KubeClient {
    const host = process.env['KUBERNETES_SERVICE_HOST'];
    const port = process.env['KUBERNETES_SERVICE_PORT'] ?? '443';
    if (host === undefined) {
      throw new Error('not inside a Kubernetes pod: KUBERNETES_SERVICE_HOST is not set');
    }
    return new KubeClient({
      server: `https://${host.includes(':') ? `[${host}]` : host}:${port}`,
      token: readFileSync(`${SERVICE_ACCOUNT}/token`, 'utf8'),
      ca: readFileSync(`${SERVICE_ACCOUNT}/ca.crt`),
      namespace: readFileSync(`${SERVICE_ACCOUNT}/namespace`, 'utf8').trim(),
    });
  }

  async listPods(labelSelector: string): Promise<Pod[]> {
    const list = (await this.#call(
      'GET',
      `/api/v1/namespaces/${this.namespace}/pods?labelSelector=${encodeURIComponent(labelSelector)}`,
    )) as { items: PodObject[] };
    return list.items.map(toPod).toSorted((a, b) => a.name.localeCompare(b.name));
  }

  /** How many replicas a Deployment wants. */
  async desiredReplicas(deployment: string): Promise<number> {
    const object = (await this.#call(
      'GET',
      `/apis/apps/v1/namespaces/${this.namespace}/deployments/${deployment}`,
    )) as { spec: { replicas: number } };
    return object.spec.replicas;
  }

  /**
   * Deletes a pod. With a grace period of 0 it disappears from the API at once and its Deployment
   * starts a replacement; the kubelet still sends SIGTERM and then, two seconds later, SIGKILL.
   * Without one, the pod's own grace period applies: preStop, SIGTERM, and time to drain.
   */
  async deletePod(name: string, gracePeriodSeconds?: number): Promise<void> {
    await this.#call('DELETE', `/api/v1/namespaces/${this.namespace}/pods/${name}`, {
      kind: 'DeleteOptions',
      apiVersion: 'v1',
      ...(gracePeriodSeconds !== undefined && { gracePeriodSeconds }),
    });
  }

  /**
   * Runs a command inside a pod's container, over the WebSocket the API server offers for exec.
   * Resolves when the session ends. It doesn't report the command's outcome: a command that kills
   * the container's main process ends its own session too, so callers check the effect instead.
   */
  exec(pod: string, container: string, command: readonly string[]): Promise<void> {
    const query = new URLSearchParams({ container, stdout: 'true', stderr: 'true' });
    for (const part of command) query.append('command', part);
    const url = new URL(
      `/api/v1/namespaces/${this.namespace}/pods/${pod}/exec?${query.toString()}`,
      this.#server,
    );
    url.protocol = 'wss:';
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url, ['v4.channel.k8s.io'], {
        ca: this.#ca,
        headers: { Authorization: `Bearer ${this.#token}` },
      });
      ws.once('close', () => {
        resolve();
      });
      ws.once('error', reject);
    });
  }

  #call(method: string, path: string, body?: unknown): Promise<unknown> {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    return new Promise((resolve, reject) => {
      const req = request(
        new URL(path, this.#server),
        {
          method,
          ca: this.#ca,
          // A fresh connection per call. Reusing one after a DELETE with a body got the next GET
          // a bare "400 Bad Request" from the API server; these calls are few, so it costs nothing.
          agent: false,
          headers: {
            Authorization: `Bearer ${this.#token}`,
            Accept: 'application/json',
            ...(payload !== undefined && {
              'Content-Type': 'application/json',
              'Content-Length': Buffer.byteLength(payload),
            }),
          },
          timeout: 10_000,
        },
        (response) => {
          const chunks: Buffer[] = [];
          response.on('data', (chunk: Buffer) => chunks.push(chunk));
          response.on('end', () => {
            const text = Buffer.concat(chunks).toString('utf8');
            const status = response.statusCode ?? 0;
            if (status >= 200 && status < 300) resolve(text === '' ? undefined : JSON.parse(text));
            else reject(new Error(`${method} ${path}: HTTP ${status} ${text.slice(0, 300)}`));
          });
        },
      );
      req.on('timeout', () => req.destroy(new Error(`${method} ${path}: timed out`)));
      req.on('error', reject);
      req.end(payload);
    });
  }
}

function toPod(object: PodObject): Pod {
  const ready = object.status?.conditions?.some(
    (condition) => condition.type === 'Ready' && condition.status === 'True',
  );
  return {
    name: object.metadata.name,
    ip: object.status?.podIP,
    ready: ready === true,
    terminating: object.metadata.deletionTimestamp !== undefined,
    restarts: (object.status?.containerStatuses ?? []).reduce(
      (sum, container) => sum + container.restartCount,
      0,
    ),
  };
}

/** The gateway pods, as the chaos driver and the runs inside the cluster find them. */
export const GATEWAY_SELECTOR = 'app.kubernetes.io/name=gateway';

/**
 * Waits until every replica the gateway Deployment wants is ready and none is shutting down, so a
 * run starts, and ends, with the whole system up.
 */
export async function waitForGateways(kube: KubeClient, timeoutMs = 180_000): Promise<Pod[]> {
  const deadline = performance.now() + timeoutMs;
  for (;;) {
    const wanted = await kube.desiredReplicas('gateway');
    const pods = await kube.listPods(GATEWAY_SELECTOR);
    const ready = pods.filter((pod) => pod.ready && !pod.terminating);
    if (ready.length === wanted && pods.length === wanted) return ready;
    if (performance.now() > deadline) {
      throw new Error(`only ${ready.length} of ${wanted} gateway pods ready after ${timeoutMs} ms`);
    }
    await sleep(250);
  }
}

/**
 * How a pod is killed:
 * - `crash`: SIGKILL to the gateway process inside the container, which gets no chance to close a
 *   socket or finish a write, exactly like the process kills of Milestone 3 (D-029) or an
 *   out-of-memory kill. Kubernetes restarts the container in the same pod.
 * - `delete`: the pod is deleted with no grace period, which is what chaos tools call a pod kill.
 *   A new pod, with a new name and address, replaces it.
 * - `drain`: the pod is deleted politely, as a rolling deploy or a node drain does: preStop,
 *   SIGTERM, and its connections closed one by one over ten seconds (D-037).
 */
export type KillMode = 'crash' | 'delete' | 'drain';

export interface PodChaosOptions {
  kube: KubeClient;
  seed: number;
  /** Wait between kills: a random time in [min, max] ms. */
  intervalMs: [number, number];
  /** Which ways to kill, picked at random for each kill. */
  modes: readonly KillMode[];
}

export interface Kill {
  /** ms since the chaos started */
  atMs: number;
  pod: string;
  mode: KillMode;
  /** Ready gateways just before this kill. */
  readyBefore: number;
}

export interface PodChaos {
  /** Stops killing, waits for the kill in progress, and lists what happened. */
  stop(): Promise<{ kills: Kill[]; skipped: number }>;
}

/**
 * Kills a gateway pod every so often, and never one of the last ready gateway: a kill only happens
 * while at least two are ready, so chargers always have somewhere to go (D-029). Kubernetes does
 * the restarting. The seed decides the waits and the kinds of kill; which pod is hit depends also
 * on which pods happen to be ready, which is timing.
 */
export function startPodChaos(options: PodChaosOptions): PodChaos {
  const { kube } = options;
  const rng = new Prng(options.seed).fork('chaos');
  const started = performance.now();
  const kills: Kill[] = [];
  let skipped = 0;
  let stopped = false;

  const loop = (async () => {
    while (!stopped) {
      await sleep(rng.int(...options.intervalMs));
      const mode = rng.pick(options.modes);
      if (stopped) break;
      const ready = (await kube.listPods(GATEWAY_SELECTOR)).filter(
        (pod) => pod.ready && !pod.terminating,
      );
      if (ready.length < 2) {
        skipped += 1;
        continue;
      }
      const victim = rng.pick(ready);
      kills.push({
        atMs: Math.round(performance.now() - started),
        pod: victim.name,
        mode,
        readyBefore: ready.length,
      });
      if (mode === 'delete') {
        await kube.deletePod(victim.name, 0);
      } else if (mode === 'drain') {
        await kube.deletePod(victim.name);
      } else {
        // tini is process 1 and survives; everything else in the container, Node included, dies.
        await kube.exec(victim.name, 'gateway', ['kill', '-KILL', '-1']).catch(() => undefined);
        await untilCrashSeen(kube, victim);
      }
    }
  })();

  return {
    async stop() {
      stopped = true;
      await loop;
      return { kills, skipped };
    },
  };
}

/** Waits until the API shows the crash: the pod unready, or its container restarted. */
async function untilCrashSeen(kube: KubeClient, victim: Pod): Promise<void> {
  const deadline = performance.now() + 10_000;
  while (performance.now() < deadline) {
    const now = (await kube.listPods(GATEWAY_SELECTOR)).find((pod) => pod.name === victim.name);
    if (!now || !now.ready || now.restarts > victim.restarts) return;
    await sleep(50);
  }
  throw new Error(`SIGKILL to ${victim.name} had no visible effect within 10 s`);
}

/** What a gateway pod reports about itself at /status, read directly from its pod address. */
export interface GatewayStatus {
  pod: string;
  connections: number;
  rssBytes: number;
  /** With `withChargers`: the chargers it holds right now, by its own account. */
  chargers?: string[];
}

export async function gatewayStatuses(
  kube: KubeClient,
  options: { withChargers?: boolean; port?: number } = {},
): Promise<GatewayStatus[]> {
  const pods = (await kube.listPods(GATEWAY_SELECTOR)).filter((pod) => pod.ready && pod.ip);
  const path = options.withChargers === true ? '/status/chargers' : '/status';
  // A pod can die between the listing and the request; it is simply missing from this sample.
  const answers = await Promise.allSettled(
    pods.map(async (pod) => {
      const response = await fetch(`http://${pod.ip}:${options.port ?? 9220}${path}`, {
        signal: AbortSignal.timeout(5_000),
      });
      const status = (await response.json()) as Omit<GatewayStatus, 'pod'>;
      return { pod: pod.name, ...status };
    }),
  );
  return answers.flatMap((answer) => (answer.status === 'fulfilled' ? [answer.value] : []));
}
