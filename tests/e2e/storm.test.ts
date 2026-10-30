import { beforeAll, describe, expect, it } from 'vitest';
import { runStorm, type StormReport } from './storm-harness.ts';

// The charger side of result 3, small enough to run every time: idle chargers on three gateway
// processes, one gateway killed with SIGKILL and started again. `pnpm storm` runs it at 2,000.

const OPTIONS = { chargers: 150, gateways: 3, seed: 7, kill: 'one', downMs: 500 } as const;
let report: StormReport;

beforeAll(async () => {
  report = await runStorm(OPTIONS);
}, 120_000);

describe(`a reconnect storm (${OPTIONS.chargers} chargers, one of ${OPTIONS.gateways} gateways killed)`, () => {
  it('notices the loss on exactly the chargers the registry put on the killed gateway', () => {
    expect(report.restart.expected).toBeGreaterThan(0);
    expect(report.restart.affected).toBe(report.restart.expected);
  });

  it('brings every one of them back, and the registry knows where each charger is', () => {
    expect(report.restart).toMatchObject({ reconnected: report.restart.affected, gaveUp: 0 });
    expect(Number.isFinite(report.restart.reconnectMs.max)).toBe(true);
    expect(report.registry.registered).toBe(OPTIONS.chargers);
  });
});
