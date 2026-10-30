import { runFleet, type FaultProfile, type FleetResult } from '@voltline/simulator';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  checkBilling,
  makeChargers,
  registerChargers,
  replayAndCompare,
  startSettler,
  startStack,
  validator,
  type BillingReport,
  type Stack,
} from './harness.ts';

// Milestone 2's exit check, small enough to run every time. `pnpm faults` runs it at full size.

const chargers = makeChargers(6, 'CP-FAULT');
const SESSIONS = 30;
const SEED = 2026;
// Far harsher than real life, so that every fault shows up even in a small run.
const HARSH: FaultProfile = {
  offline: 0.6,
  lostResponse: 0.15,
  dropAfterSend: 0.05,
  reorder: 0.8,
  meterReset: 0.5,
};

let stack: Stack;
let fleet: FleetResult;
let report: BillingReport;
let settled: { whileRunning: number; atTheEnd: number };

beforeAll(async () => {
  stack = await startStack();
  await registerChargers(stack.db.pool, chargers);
  // Settlement runs all the way through with no quiet period, so a session settles as soon as it
  // stops, and any evidence after that has to go in as a correction (D-034).
  const settler = startSettler(stack.db.pool, { quietMs: 0, everyMs: 5 });
  fleet = await runFleet({
    gatewayUrl: stack.gatewayUrl,
    chargers,
    sessions: SESSIONS,
    seed: SEED,
    faults: HARSH,
    validator,
  });
  await stack.frameLog.flush();
  settled = await settler.stop();
  report = await checkBilling(stack.db.pool, fleet.sessions, { settled: true });
}, 120_000);

afterAll(async () => {
  await stack.stop();
});

describe(`billing under faults (seed ${SEED}, ${SESSIONS} sessions, one gateway)`, () => {
  it('actually injected every kind of fault', () => {
    expect(fleet.failures).toEqual([]);
    for (const [kind, count] of Object.entries(report.faults)) {
      expect(count, kind).toBeGreaterThan(0);
    }
  });

  it('bills every session exactly, and loses or invents none', () => {
    expect(report.problems).toEqual([]);
    expect(report).toMatchObject({
      simulated: SESSIONS,
      inDatabase: SESSIONS,
      lost: 0,
      invented: 0,
      discrepancies: 0,
    });
  });

  it('settles every session while the chargers run, and corrects instead of editing', () => {
    // checkBilling also holds each session to: settled bill + corrections = bill.
    expect(report.settlement?.settled).toBe(SESSIONS);
    expect(settled.whileRunning).toBeGreaterThan(0);
  });

  it('never bills more than flowed', () => {
    expect(report.energy.billedWh).toBe(report.energy.evidencedWh);
    expect(report.energy.evidencedWh).toBeLessThanOrEqual(report.energy.physicalWh);
  });

  it('reproduces every bill by replaying the recorded frames into an empty database', async () => {
    await stack.frameLog.flush();
    const source = { db: stack.db.pool, redis: stack.redis, logger: stack.logger };
    expect(await replayAndCompare(source, chargers)).toEqual({
      sessions: SESSIONS,
      mismatches: [],
    });
  });
});
