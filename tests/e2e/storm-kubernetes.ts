/**
 * Idle chargers inside the kind cluster (result 3's setting, and Milestone 1's kind trial). A Job
 * starts thousands of idle chargers that connect through the gateway Service; optionally one
 * gateway pod, or all of them, is then killed and Kubernetes brings them back. Every time is
 * measured from the chargers' side, from inside the cluster (D-035).
 */
import { setTimeout as sleep } from 'node:timers/promises';
import { createTestRedis } from '@voltline/availability/testing';
import { Prng } from '@voltline/common';
import { createPool } from '@voltline/db';
import { ConnectionRegistry } from '@voltline/routing';
import { IdleCharger } from '@voltline/simulator';
import { forgetChargers, makeChargers, registerChargers, validator } from './harness.ts';
import {
  gatewayStatuses,
  KubeClient,
  waitForGateways,
  type GatewayStatus,
  type KillMode,
} from './kubernetes.ts';
import { percentiles, type Percentiles } from './storm-harness.ts';

export interface KubeStormOptions {
  chargers: number;
  seed: number;
  /** 'none' only starts the chargers and watches them: the kind trial. */
  kill: 'none' | 'one' | 'all';
  killMode: KillMode;
  /** How long to keep watching once every charger is connected. */
  holdMs: number;
  /** false: every charger waits the full backoff, in step with the others. Default true. */
  jitter?: boolean;
  /** The gateway Service, e.g. ws://gateway:9220/ocpp. */
  gatewayUrl: string;
}

/** How many chargers each gateway pod held, by its own count, at one moment. */
export interface SpreadSample {
  /** ms since the watch began */
  atMs: number;
  byPod: Record<string, number>;
}

export interface KubeStormReport {
  options: KubeStormOptions;
  gatewayPods: number;
  coldStart: {
    /** Per charger: from starting to a gateway accepting its BootNotification. */
    bootMs: Percentiles;
    /** Until the last charger was accepted. */
    allBootedMs: number;
    /** BootNotifications answered Pending, across all chargers. */
    pendingBoots: number;
    gateways: GatewayStatus[];
  };
  restart?: {
    victims: string[];
    /** Chargers whose sockets were on the victims just before the kill, by the victims' own lists. */
    expected: number;
    /** Of those, the ones that noticed they had lost their connection. */
    affected: number;
    /**
     * Of those, the ones already reconnecting when the kill came: moved a moment before by
     * rebalancing, and still waiting to be accepted. Their outage is timed from when it began.
     */
    alreadyReconnecting: number;
    reconnected: number;
    gaveUp: number;
    /** Each of them, from noticing the loss to a gateway accepting its BootNotification again. */
    reconnectMs: Percentiles;
    attempts: Percentiles;
    pendingBoots: number;
    /** How their connections ended, by WebSocket close code: 1006 broke, 1001 drained. */
    closeCodes: Record<string, number>;
    /** From the kill until the last of them was back. */
    allBackMs: number;
    /**
     * Connections the gateways closed afterwards to even the load out again (close code 1013,
     * D-039), from the kill to the end of the watch.
     */
    rebalanced: number;
    /** Chargers connected and accepted, every 100 ms from the kill. */
    timeline: number[];
    /** Up to 10 chargers the victims held that never noticed the kill, with their history. */
    silent: {
      chargePointId: string;
      connected: boolean;
      socketsOpened: number;
      /** ms relative to the kill, and the close code */
      losses: { atMs: number; closeCode: number; backAtMs: number | null }[];
    }[];
  };
  hold: {
    /** Connections lost while watching, other than rebalancing moves: should be none. */
    lostDuring: number;
    /** Each pod's own count of its chargers, every second. */
    spread: SpreadSample[];
  };
  /** At the end: where the registry says each charger is. */
  registry: { registered: number; byGateway: Record<string, number> };
  /**
   * Just before the kill: the registry against each gateway's own list of its chargers. Chargers
   * it had wrong would be missing from the numbers (D-035).
   */
  registryCheck?: {
    checked: number;
    wrong: { chargePointId: string; registry: string | null; actual: string | null }[];
  };
}

export async function runStormInKubernetes(options: KubeStormOptions): Promise<KubeStormReport> {
  const kube = KubeClient.inCluster();
  const db = createPool();
  const redis = createTestRedis();
  // The gateways as deployed use the default key prefix.
  const registry = new ConnectionRegistry(redis);
  const identities = makeChargers(options.chargers, 'CP-STORM');
  await forgetChargers(db, identities);
  await registerChargers(db, identities);
  const gatewayPods = (await waitForGateways(kube)).length;

  const root = new Prng(options.seed);
  const chargers = identities.map(
    ({ chargePointId }) =>
      new IdleCharger({
        gatewayUrls: [options.gatewayUrl],
        chargePointId,
        rng: root.fork(chargePointId),
        validator,
        ...(options.jitter === false && { jitter: false }),
      }),
  );
  // Rebalancing moves (close code 1013) aren't failures, so they are counted apart (D-039).
  const lostSoFar = () =>
    chargers.reduce(
      (sum, charger) =>
        sum + charger.reconnects.filter((reconnect) => reconnect.closeCode !== 1013).length,
      0,
    );
  const owners = () =>
    Promise.all(identities.map(({ chargePointId }) => registry.owner(chargePointId)));

  try {
    const started = performance.now();
    await Promise.all(chargers.map((charger) => charger.start()));
    const coldStart = {
      bootMs: percentiles(chargers.map((charger) => charger.firstBootMs ?? Infinity)),
      allBootedMs: performance.now() - started,
      pendingBoots: chargers.reduce((sum, charger) => sum + charger.firstPendingBoots, 0),
      gateways: await gatewayStatuses(kube),
    };

    let restart: KubeStormReport['restart'];
    let rebalancedSince = Infinity;
    let registryCheck: KubeStormReport['registryCheck'];
    if (options.kill !== 'none') {
      const pods = await waitForGateways(kube);
      const victims =
        options.kill === 'all' ? pods : [new Prng(options.seed).fork('victim').pick(pods)];
      const victimNames = new Set(victims.map((pod) => pod.name));
      // The registry against the truth: each gateway's own list of the chargers it holds.
      const truth = await gatewayStatuses(kube, { withChargers: true });
      const placed = await owners();
      const actualOwner = new Map(
        truth.flatMap((gateway) => (gateway.chargers ?? []).map((id) => [id, gateway.pod])),
      );
      registryCheck = { checked: identities.length, wrong: [] };
      identities.forEach(({ chargePointId }, i) => {
        const said = placed[i]?.gatewayId;
        const actual = actualOwner.get(chargePointId);
        if (said !== actual) {
          registryCheck?.wrong.push({
            chargePointId,
            registry: said ?? null,
            actual: actual ?? null,
          });
        }
      });
      // Expected to notice: the chargers whose socket was on a victim, by the gateways' own lists.
      const onVictims = chargers.filter((charger) =>
        victimNames.has(actualOwner.get(charger.chargePointId) ?? ''),
      );

      const timeline: number[] = [];
      const sample = () => timeline.push(chargers.filter((charger) => charger.connected).length);
      const killedAt = performance.now();
      const sampler = setInterval(sample, 100);
      await Promise.all(
        victims.map((pod) =>
          options.killMode === 'crash'
            ? kube.exec(pod.name, 'gateway', ['kill', '-KILL', '-1']).catch(() => undefined)
            : kube.deletePod(pod.name, options.killMode === 'delete' ? 0 : undefined),
        ),
      );
      // Each victim's charger has one outage that the kill caused or caught it in: a loss after the
      // kill (a deleted pod closes its sockets only after its grace period), or a reconnect that
      // was still under way when the kill came. Wait until every one has noticed and is back.
      const deadline = performance.now() + 60_000;
      const firstLoss = (charger: IdleCharger) =>
        charger.reconnects.find(
          (reconnect) =>
            reconnect.lostAt >= killedAt ||
            reconnect.bootedAt === undefined ||
            reconnect.bootedAt > killedAt,
        );
      const settled = () =>
        onVictims.every((charger) => {
          const loss = firstLoss(charger);
          return loss !== undefined && (loss.bootedAt !== undefined || loss.gaveUp);
        });
      while (!settled() && performance.now() < deadline) await sleep(20);
      clearInterval(sampler);
      sample();
      const losses = onVictims.flatMap((charger) => {
        const loss = firstLoss(charger);
        return loss === undefined ? [] : [loss];
      });
      const back = losses.flatMap((loss) => (loss.bootedAt === undefined ? [] : [loss.bootedAt]));
      const closeCodes: Record<string, number> = {};
      for (const loss of losses) {
        closeCodes[loss.closeCode] = (closeCodes[loss.closeCode] ?? 0) + 1;
      }
      restart = {
        victims: [...victimNames],
        expected: onVictims.length,
        affected: losses.length,
        alreadyReconnecting: losses.filter((loss) => loss.lostAt < killedAt).length,
        reconnected: back.length,
        gaveUp: losses.filter((loss) => loss.gaveUp).length,
        reconnectMs: percentiles(losses.map((loss) => (loss.bootedAt ?? Infinity) - loss.lostAt)),
        attempts: percentiles(losses.map((loss) => loss.attempts)),
        pendingBoots: losses.reduce((sum, loss) => sum + loss.pendingBoots, 0),
        closeCodes,
        allBackMs: back.length === 0 ? 0 : Math.max(...back) - killedAt,
        rebalanced: 0, // counted at the end of the watch
        timeline,
        silent: onVictims
          .filter((charger) => firstLoss(charger) === undefined)
          .slice(0, 10)
          .map((charger) => ({
            chargePointId: charger.chargePointId,
            connected: charger.connected,
            socketsOpened: charger.socketsOpened,
            losses: charger.reconnects.map((reconnect) => ({
              atMs: Math.round(reconnect.lostAt - killedAt),
              closeCode: reconnect.closeCode,
              backAtMs:
                reconnect.bootedAt === undefined ? null : Math.round(reconnect.bootedAt - killedAt),
            })),
          })),
      };
      rebalancedSince = killedAt;
      await waitForGateways(kube);
    }

    // Watch: nobody should lose a connection now, and the pods' counts show how even it is.
    const lostBefore = lostSoFar();
    const watchStart = performance.now();
    const spread: SpreadSample[] = [];
    do {
      const statuses = await gatewayStatuses(kube);
      spread.push({
        atMs: Math.round(performance.now() - watchStart),
        byPod: Object.fromEntries(statuses.map((status) => [status.pod, status.connections])),
      });
      await sleep(1_000);
    } while (performance.now() - watchStart < options.holdMs);

    if (restart) {
      restart.rebalanced = chargers.reduce(
        (sum, charger) =>
          sum +
          charger.reconnects.filter(
            (reconnect) => reconnect.closeCode === 1013 && reconnect.lostAt >= rebalancedSince,
          ).length,
        0,
      );
    }
    const byGateway: Record<string, number> = {};
    for (const owner of await owners()) {
      if (owner) byGateway[owner.gatewayId] = (byGateway[owner.gatewayId] ?? 0) + 1;
    }
    return {
      options,
      gatewayPods,
      coldStart,
      ...(restart && { restart }),
      ...(registryCheck && { registryCheck }),
      hold: { lostDuring: lostSoFar() - lostBefore, spread },
      registry: {
        registered: Object.values(byGateway).reduce((sum, count) => sum + count, 0),
        byGateway,
      },
    };
  } finally {
    await Promise.all(chargers.map((charger) => charger.stop()));
    await forgetChargers(db, identities);
    await redis.quit();
    await db.end();
  }
}
