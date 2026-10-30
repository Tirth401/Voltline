import type { ConnectorState, LimitChange } from '@voltline/smart-charging';
import { beforeAll, describe, expect, it } from 'vitest';
import { runCapScenario, type CapReport } from './power-harness.ts';

// Milestone 3's last exit check: the site never exceeds its power cap while cars come and go,
// chargers refuse limits or lose their answers, and some drop offline for longer than their
// lease (D-032). The verdict uses what the chargers actually apply, not what the controller
// believes, and usefulness is checked next to it (D-016).

const SCENARIO = { seed: 2028, chargers: 8, capW: 60_000, changes: 200 };
const DEFAULT_W = 4_140;
// Load changes here come faster than the controller's 50 ms tick, so it can't keep up: this only
// rules out doing nothing. `pnpm cap --gap 150-450` measures usefulness at a calmer pace.
const USEFUL_AT_LEAST = 0.3;

/** A careless controller: every target straight away, no ordering, no worst-case budget. */
const careless = (
  _capW: number,
  connectors: readonly ConnectorState[],
  targets: ReadonlyMap<string, number>,
): LimitChange[] =>
  connectors
    .filter((c) => c.online && c.inFlightW === undefined)
    .filter((c) => (targets.get(c.key) ?? c.defaultW) !== c.acknowledgedW)
    .map((c) => ({ key: c.key, limitW: targets.get(c.key) ?? c.defaultW }));

let safe: CapReport;
let unsafe: CapReport;
let restarted: CapReport;

beforeAll(async () => {
  // Independent sites (their own database schema, Redis prefix and gateway), so they run at once.
  [safe, unsafe, restarted] = await Promise.all([
    runCapScenario(SCENARIO),
    runCapScenario({ ...SCENARIO, planner: careless }),
    // The controller crashes and starts afresh every 2.5 s, with no memory of the limits it set.
    runCapScenario({ ...SCENARIO, restartEveryMs: 2_500 }),
  ]);
}, 180_000);

describe(`smart charging (seed ${SCENARIO.seed}, ${SCENARIO.changes} load changes, 8 chargers, 60 kW cap)`, () => {
  it('really put the site under pressure', () => {
    expect(safe.arrivals + safe.departures).toBe(SCENARIO.changes);
    expect(safe.offlineSpells).toBeGreaterThan(0);
    expect(safe.profiles.refused).toBeGreaterThan(0);
    // Lost answers are the dangerous case: the controller can't know what the charger applied.
    expect(safe.profiles.unanswered).toBeGreaterThan(0);
    expect(safe.profiles.errors).toBe(0);
  });

  it('never let the chargers draw more than the cap, at any moment', () => {
    expect(safe.peakW).toBeLessThanOrEqual(SCENARIO.capW);
  });

  it('hands out most of the spare power, so it is not safe by doing nothing', () => {
    expect(safe.peakW).toBeGreaterThan(SCENARIO.chargers * DEFAULT_W);
    expect(safe.usefulness).toBeGreaterThan(USEFUL_AT_LEAST);
  });

  it('settles every charging car at its fair target once the faults stop', () => {
    expect(safe.unsettled).toEqual([]);
  });

  it('catches a careless controller breaking the cap, so the check is not vacuous', () => {
    expect(unsafe.peakW).toBeGreaterThan(SCENARIO.capW);
  });

  it('survives controller restarts in the middle of it all', () => {
    // Why a fresh controller must wait first is shown step by step in controller-restart.test.ts.
    expect(restarted.controllerRestarts).toBeGreaterThan(1);
    expect(restarted.peakW).toBeLessThanOrEqual(SCENARIO.capW);
    expect(restarted.unsettled).toEqual([]);
  });
});
