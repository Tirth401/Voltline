import { describe, expect, it } from 'vitest';
import { LimitRecorder } from './power-site.ts';

describe('LimitRecorder', () => {
  it('finds the highest total the site was allowed to draw, moment by moment', () => {
    const recorder = new LimitRecorder();
    recorder.record('A', 4_140);
    recorder.record('B', 4_140);
    recorder.record('A', 14_140); // 18,280 W in total
    recorder.record('B', 9_140); // raised before A came down: 23,280 W for a moment
    recorder.record('A', 9_140); // 18,280 W again
    expect(recorder.peakTotalW()).toBe(23_280);
    expect(recorder.current('A')).toBe(9_140);
  });

  it('ignores repeats of the same limit', () => {
    const recorder = new LimitRecorder();
    recorder.record('A', 4_140);
    recorder.record('A', 4_140);
    expect(recorder.changes).toBe(1);
  });

  it('measures usefulness as the share of the spare power handed out, over time', () => {
    let now = 0;
    const recorder = new LimitRecorder(() => now);
    // Cap 30 kW, default 5 kW, two connectors: 10 kW is the floor, 20 kW is spare.
    recorder.record('A', 5_000);
    recorder.record('B', 5_000);
    now = 10;
    recorder.recordDemand('A', 20_000); // a car wants 15 kW more than the default
    now = 20;
    recorder.record('A', 20_000); // and gets it, 10 ms later
    now = 40;
    // Possible: 15 kW from 10 to 40. Given: 15 kW from 20 to 40. Nothing is possible before 10.
    expect(recorder.usefulness(30_000, 5_000, 0, 40)).toBeCloseTo(2 / 3);
    expect(recorder.usefulness(30_000, 5_000, 20, 40)).toBe(1);
  });

  it('never counts more as possible than the cap leaves', () => {
    let now = 0;
    const recorder = new LimitRecorder(() => now);
    recorder.record('A', 5_000);
    recorder.record('B', 5_000);
    recorder.recordDemand('A', 22_000);
    recorder.recordDemand('B', 22_000); // 34 kW wanted beyond the floor, only 20 kW spare
    recorder.record('A', 15_000);
    recorder.record('B', 15_000); // the fair split uses all 20 kW
    now = 100;
    expect(recorder.usefulness(30_000, 5_000, 0, 100)).toBe(1);
  });
});
