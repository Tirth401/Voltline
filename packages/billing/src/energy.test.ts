import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { computeEnergyWh, type RegisterReading } from './energy.ts';

const T0 = Date.parse('2026-01-01T08:00:00Z');
const reading = (minute: number, wh: number): RegisterReading => ({
  ts: new Date(T0 + minute * 60_000),
  wh,
});

/** A session whose meter only ever goes up: readings every minute, then the stop. */
const steadySession = fc
  .record({
    startWh: fc.nat({ max: 1_000_000_000 }),
    increments: fc.array(fc.nat({ max: 50_000 }), { minLength: 1, maxLength: 40 }),
  })
  .map(({ startWh, increments }) => {
    const path: RegisterReading[] = [];
    let wh = startWh;
    increments.forEach((increment, i) => {
      wh += increment;
      path.push(reading(i + 1, wh));
    });
    const stop = path.pop() as RegisterReading;
    return { start: reading(0, startWh), between: path, stop };
  });

/**
 * A session whose meter resets between segments, reported the way a well-behaved charger does
 * around a reboot: the register just before (Interruption.Begin), then 0 just after (Interruption.End).
 */
const gracefullyResettingSession = fc
  .record({
    startWh: fc.nat({ max: 1_000_000 }),
    segments: fc.array(
      fc.array(fc.integer({ min: 1, max: 5_000 }), { minLength: 1, maxLength: 8 }),
      {
        minLength: 1,
        maxLength: 5,
      },
    ),
  })
  .map(({ startWh, segments }) => {
    const readings: RegisterReading[] = [];
    let minute = 0;
    let wh = startWh;
    let physicalWh = 0;
    segments.forEach((segment, index) => {
      if (index > 0) {
        wh = 0;
        readings.push(reading(++minute, 0));
      }
      for (const increment of segment) {
        wh += increment;
        physicalWh += increment;
        readings.push(reading(++minute, wh));
      }
    });
    const stop = readings.pop() as RegisterReading;
    return { start: reading(0, startWh), readings, stop, physicalWh, resets: segments.length - 1 };
  });

describe('computeEnergyWh', () => {
  it('bills the worked example in DECISIONS.md D-009: one visible reset', () => {
    // Starts at 10,000. Reads 14,800, climbs unreported to 15,000, resets, reads 200 and 1,100,
    // stops at 3,000. 8,000 Wh flowed; the readings evidence 7,800.
    const result = computeEnergyWh(
      reading(0, 10_000),
      [reading(10, 14_800), reading(20, 200), reading(30, 1_100)],
      reading(40, 3_000),
    );
    expect(result).toEqual({ energyWh: 7_800, resetsDetected: 1 });
  });

  it('is stop minus start when there are no readings in between', () => {
    expect(computeEnergyWh(reading(0, 1_000), [], reading(60, 2_234))).toEqual({
      energyWh: 1_234,
      resetsDetected: 0,
    });
  });

  it('ignores readings from before the start or after the stop', () => {
    const result = computeEnergyWh(
      reading(10, 1_000),
      [reading(5, 0), reading(15, 1_500), reading(25, 0)],
      reading(20, 2_000),
    );
    expect(result).toEqual({ energyWh: 1_000, resetsDetected: 0 });
  });

  it('without resets, ignores lost, duplicated and out-of-order readings', () => {
    const scenario = steadySession.chain((session) =>
      fc.tuple(
        fc.constant(session),
        fc.shuffledSubarray(session.between),
        fc.shuffledSubarray(session.between),
      ),
    );
    fc.assert(
      fc.property(scenario, ([session, kept, duplicates]) => {
        expect(computeEnergyWh(session.start, [...kept, ...duplicates], session.stop)).toEqual({
          energyWh: session.stop.wh - session.start.wh,
          resetsDetected: 0,
        });
      }),
    );
  });

  it('bills reported resets exactly, in any arrival order', () => {
    const scenario = gracefullyResettingSession.chain((session) =>
      fc.tuple(
        fc.constant(session),
        fc.shuffledSubarray(session.readings, { minLength: session.readings.length }),
      ),
    );
    fc.assert(
      fc.property(scenario, ([session, arrivalOrder]) => {
        expect(computeEnergyWh(session.start, arrivalOrder, session.stop)).toEqual({
          energyWh: session.physicalWh,
          resetsDetected: session.resets,
        });
      }),
    );
  });

  it('cannot see a reset when the meter climbs past its last reading before reporting again', () => {
    // Reads 1,100, climbs unreported to 1,150, resets to 0, climbs to 1,500, stops there.
    // 1,650 Wh flowed, but the readings look exactly like a meter going from 1,100 to 1,500.
    const result = computeEnergyWh(reading(0, 1_000), [reading(10, 1_100)], reading(20, 1_500));
    expect(result).toEqual({ energyWh: 500, resetsDetected: 0 });
  });

  it('never bills less after one more reading: late evidence can only add energy', () => {
    // So a correction to a settled bill can only ever raise it (D-034).
    const wh = fc.nat({ max: 1_000_000 });
    const readings = fc.uniqueArray(fc.record({ minute: fc.integer({ min: 1, max: 59 }), wh }), {
      selector: (r) => r.minute,
      minLength: 1,
      maxLength: 20,
    });
    fc.assert(
      fc.property(wh, wh, readings, (startWh, stopWh, all) => {
        const asReadings = (list: typeof all) => list.map((r) => reading(r.minute, r.wh));
        const [, ...withoutTheLateOne] = all;
        const before = computeEnergyWh(
          reading(0, startWh),
          asReadings(withoutTheLateOne),
          reading(60, stopWh),
        );
        const after = computeEnergyWh(reading(0, startWh), asReadings(all), reading(60, stopWh));
        expect(after.energyWh).toBeGreaterThanOrEqual(before.energyWh);
      }),
    );
  });
});
