/**
 * The smart-charging check (D-032): a site of simulated chargers, a real gateway and command bus,
 * and the charging controller, while cars come and go. The verdict comes from what the chargers
 * actually apply, recorded independently of the controller.
 */
import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { AvailabilityStore } from '@voltline/availability';
import { createTestRedis, deleteKeysWithPrefix } from '@voltline/availability/testing';
import {
  createController,
  type ControllerOptions,
  type SiteController,
} from '@voltline/charging-controller';
import { Prng, systemClock } from '@voltline/common';
import { createTestDatabase } from '@voltline/db/testing';
import { createGateway } from '@voltline/gateway';
import { CommandBus, ConnectionRegistry } from '@voltline/routing';
import { LimitRecorder, PowerCharger, runLoadChanges, type PowerFaults } from '@voltline/simulator';
import { pino } from 'pino';
import { makeChargers, validator } from './harness.ts';

// Short leases, so chargers that drop offline for 0.5 to 2.5 s really do fall back.
export const LEASE_MS = 1_500;
export const CLOCK_SKEW_MS = 300;
const TICK_MS = 50;

/** How the chargers misbehave, unless the scenario says otherwise. */
export const FAULTS: PowerFaults = { rejectProfile: 0.1, loseAnswer: 0.05, answerDelayMs: [0, 40] };

export interface PowerSiteOptions {
  seed: number;
  chargers: number;
  capW: number;
  defaultW?: number;
  maxW?: number;
  /** How the chargers misbehave. Default: FAULTS. */
  faults?: PowerFaults;
}

type ControllerOverrides = Pick<ControllerOptions, 'planner' | 'startupQuietMs'>;

/** One site, its chargers connected to a real gateway, and a controller you can start and restart. */
export interface PowerSite {
  readonly chargers: readonly PowerCharger[];
  readonly recorder: LimitRecorder;
  readonly defaultW: number;
  /** What came back for each SetChargingProfile, as the controller heard it. */
  readonly profiles: ProfileOutcomes;
  /** The seed's root stream: fork it for whatever drives the site. */
  readonly rng: Prng;
  /**
   * Starts a controller that ticks every 50 ms. If one is already running, the new one takes
   * over, as after a crash: everything the old one believed is gone.
   */
  startController(overrides?: ControllerOverrides): void;
  /** Stops the controller and returns the fair targets of one last tick. */
  stopController(): Promise<Map<string, number>>;
  close(): Promise<void>;
}

export interface ProfileOutcomes {
  accepted: number;
  refused: number;
  /** No answer in time: lost on the way back, or the charger dropped off mid-change. */
  unanswered: number;
  /** The charger had dropped off before the command went out. */
  notConnected: number;
  /** Invalid commands or CALLERRORs. Always a bug here. */
  errors: number;
}

export async function startPowerSite(options: PowerSiteOptions): Promise<PowerSite> {
  const defaultW = options.defaultW ?? 4_140; // 6 A on three phases at 230 V
  const maxW = options.maxW ?? 22_000;
  const siteId = 'SITE-CAP';
  const prefix = `voltline-test-${randomUUID()}:`;
  const logger = pino({ level: 'silent' });
  const chargers = makeChargers(options.chargers, 'CP-POWER');

  const db = await createTestDatabase();
  const redis = createTestRedis();
  const registry = new ConnectionRegistry(redis, prefix);
  const gatewayBus = new CommandBus(redis, registry, { keyPrefix: prefix, timeoutMs: 2_000 });
  const controllerBus = new CommandBus(redis, registry, { keyPrefix: prefix, timeoutMs: 2_000 });
  const recorder = new LimitRecorder();
  const profiles: ProfileOutcomes = {
    accepted: 0,
    refused: 0,
    unanswered: 0,
    notConnected: 0,
    errors: 0,
  };
  // The controller's own bus, with each outcome counted on the way back.
  const countingBus: Pick<CommandBus, 'send'> = {
    send: async (...args) => {
      const outcome = await controllerBus.send(...args);
      if (outcome.status === 'answered') {
        if (outcome.result['status'] === 'Accepted') profiles.accepted += 1;
        else profiles.refused += 1;
      } else if (outcome.status === 'timeout') profiles.unanswered += 1;
      else if (outcome.status === 'not-connected') profiles.notConnected += 1;
      else profiles.errors += 1;
      return outcome;
    },
  };
  let sim: PowerCharger[] = [];
  const gateway = createGateway({
    db: db.pool,
    availability: new AvailabilityStore(redis, prefix),
    validator,
    logger,
    gatewayId: 'gw-power',
    routing: { registry, bus: gatewayBus },
    callTimeoutMs: 2_000, // a lost answer isn't waited for longer than the controller waits
  });
  let controller: SiteController | undefined;
  let loop: Promise<void> | undefined;
  let ticking = false;

  async function close(): Promise<void> {
    ticking = false;
    await loop;
    await Promise.all(sim.map((charger) => charger.close()));
    await gateway.close();
    await gatewayBus.close();
    await controllerBus.close();
    await deleteKeysWithPrefix(redis, prefix);
    await redis.quit();
    await db.drop();
  }

  const root = new Prng(options.seed);
  try {
    await db.pool.query(
      `INSERT INTO sites (id, name, power_cap_w, fallback_limit_w) VALUES ($1, 'Cap check', $2, $3)`,
      [siteId, options.capW, defaultW],
    );
    await db.pool.query(
      `INSERT INTO charge_points (id, site_id, max_power_w) SELECT unnest($1::text[]), $2, $3`,
      [chargers.map((c) => c.chargePointId), siteId, maxW],
    );
    await db.pool.query('INSERT INTO id_tags (id_tag) SELECT unnest($1::text[])', [
      chargers.map((c) => c.idTag),
    ]);
    const gatewayUrl = `ws://127.0.0.1:${(await gateway.listen(0, '127.0.0.1')).port}/ocpp`;
    sim = chargers.map(
      ({ chargePointId, idTag }) =>
        new PowerCharger({
          gatewayUrl,
          chargePointId,
          idTag,
          defaultW,
          maxW,
          rng: root.fork(chargePointId),
          faults: options.faults ?? FAULTS,
          recorder,
          validator,
        }),
    );
    await Promise.all(sim.map((charger) => charger.connect()));
  } catch (error) {
    await close();
    throw error;
  }

  return {
    chargers: sim,
    recorder,
    defaultW,
    profiles,
    rng: root,
    startController(overrides = {}) {
      controller = createController({
        db: db.pool,
        bus: countingBus,
        registry,
        siteId,
        clock: systemClock,
        logger,
        leaseMs: LEASE_MS,
        clockSkewMs: CLOCK_SKEW_MS,
        ...overrides,
      });
      if (ticking) return; // the running loop ticks the new one from now on
      ticking = true;
      loop = (async () => {
        while (ticking && controller) {
          await controller.tick();
          await sleep(TICK_MS);
        }
      })();
    },
    async stopController() {
      ticking = false;
      await loop;
      return controller ? (await controller.tick()).targets : new Map<string, number>();
    },
    close,
  };
}

export interface CapScenario extends PowerSiteOptions {
  /** Cars arriving or leaving, in total. */
  changes: number;
  /** Swap in a careless planner to prove the check can fail. */
  planner?: ControllerOptions['planner'];
  /** Real time between load changes: [min, max] ms. Default [10, 40]: much faster than real life. */
  gapMs?: [number, number];
  /** Restart the controller this often during the load changes, losing all it believed. */
  restartEveryMs?: number;
}

export interface CapReport {
  capW: number;
  /** The most the chargers were ever allowed to draw at once, by their own record. */
  peakW: number;
  /** Share of the spare power the chargers were allowed to use during the load changes (D-016). */
  usefulness: number;
  arrivals: number;
  departures: number;
  offlineSpells: number;
  profiles: ProfileOutcomes;
  /** Limit changes the chargers applied, lease fall-backs included. */
  limitChanges: number;
  /** Connectors not at their fair target once the faults stopped (should be none). */
  unsettled: string[];
  controllerRestarts: number;
  seconds: number;
}

/** Cars arrive and leave at seeded moments while chargers misbehave and drop offline. */
export async function runCapScenario(scenario: CapScenario): Promise<CapReport> {
  const site = await startPowerSite(scenario);
  const overrides = scenario.planner ? { planner: scenario.planner } : {};
  try {
    site.startController(overrides);
    // A controller that has been running for a while, not one that has just started.
    await sleep(LEASE_MS + CLOCK_SKEW_MS);

    let controllerRestarts = 0;
    const restarts =
      scenario.restartEveryMs === undefined
        ? undefined
        : setInterval(() => {
            site.startController(overrides);
            controllerRestarts += 1;
          }, scenario.restartEveryMs);
    const started = performance.now();
    const load = await runLoadChanges({
      chargers: site.chargers,
      changes: scenario.changes,
      rng: site.rng.fork('load'),
      gapMs: scenario.gapMs ?? [10, 40],
      offlineChance: 0.05,
      offlineMs: [500, 2_500],
    });
    const ended = performance.now();
    clearInterval(restarts);

    // Every charger is back online. Now the faults stop too, and every connector should reach
    // its fair target within a few seconds.
    for (const charger of site.chargers) {
      charger.setFaults({ ...(scenario.faults ?? FAULTS), rejectProfile: 0, loseAnswer: 0 });
    }
    await sleep(3_000);
    const targets = await site.stopController();

    const unsettled = site.chargers
      .filter((charger) => {
        const expected = charger.charging ? targets.get(charger.key) : site.defaultW;
        return site.recorder.current(charger.key) !== expected;
      })
      .map((charger) => charger.key);
    return {
      capW: scenario.capW,
      peakW: site.recorder.peakTotalW(),
      usefulness: site.recorder.usefulness(scenario.capW, site.defaultW, started, ended),
      ...load,
      profiles: site.profiles,
      limitChanges: site.recorder.changes,
      unsettled,
      controllerRestarts,
      seconds: (ended - started) / 1000,
    };
  } finally {
    await site.close();
  }
}
