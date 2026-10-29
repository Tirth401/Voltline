import { computeEnergyWh, type RegisterReading } from '@voltline/billing';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { Meter } from './meter.ts';

const T0 = Date.parse('2026-01-01T08:00:00Z');
const at = (minute: number): Date => new Date(T0 + minute * 60_000);

type Step =
  | { kind: 'deliver'; wh: number }
  | { kind: 'emit' }
  | { kind: 'gracefulReset' }
  | { kind: 'hardReset' };

/** Plays a script against a meter the way a charger would, keeping every reading it emits. */
function play(initialWh: number, steps: readonly Step[]) {
  const meter = new Meter(initialWh);
  const start: RegisterReading = { ts: at(0), wh: meter.beginSession() };
  const readings: RegisterReading[] = [];
  let minute = 0;
  const emit = (): void => {
    readings.push({ ts: at(++minute), wh: meter.emit() });
  };
  for (const step of steps) {
    switch (step.kind) {
      case 'deliver':
        meter.deliver(step.wh);
        break;
      case 'emit':
        emit();
        break;
      case 'gracefulReset': // Interruption.Begin, the reset, Interruption.End
        emit();
        meter.reset();
        emit();
        break;
      case 'hardReset':
        meter.reset();
        break;
    }
  }
  const stop: RegisterReading = { ts: at(++minute), wh: meter.emit() };
  return { meter, start, readings, stop };
}

const scripts = fc.array(
  fc.oneof(
    fc.record({ kind: fc.constant('deliver' as const), wh: fc.nat({ max: 20_000 }) }),
    fc.constant({ kind: 'emit' as const }),
    fc.constant({ kind: 'gracefulReset' as const }),
    fc.constant({ kind: 'hardReset' as const }),
  ),
  { maxLength: 60 },
);

describe('Meter', () => {
  it('evidences everything that flowed when it never resets', () => {
    const { meter } = play(1_000, [
      { kind: 'deliver', wh: 300 },
      { kind: 'emit' },
      { kind: 'deliver', wh: 200 },
    ]);
    expect([meter.physicalWh, meter.evidencedWh]).toEqual([500, 500]);
  });

  it('loses what flowed between the last reading and a hard reset (the D-009 example)', () => {
    const { meter } = play(10_000, [
      { kind: 'deliver', wh: 4_800 },
      { kind: 'emit' }, // reads 14,800
      { kind: 'deliver', wh: 200 },
      { kind: 'hardReset' }, // reached 15,000 unreported, then reset
      { kind: 'deliver', wh: 200 },
      { kind: 'emit' }, // reads 200
      { kind: 'deliver', wh: 900 },
      { kind: 'emit' }, // reads 1,100
      { kind: 'deliver', wh: 1_900 }, // stops at 3,000
    ]);
    expect([meter.physicalWh, meter.evidencedWh]).toEqual([8_000, 7_800]);
  });

  it('loses more when the meter climbs past its last reading before the next one', () => {
    const { meter } = play(1_000, [
      { kind: 'deliver', wh: 100 },
      { kind: 'emit' }, // reads 1,100
      { kind: 'deliver', wh: 50 },
      { kind: 'hardReset' }, // reached 1,150 unreported, then reset
      { kind: 'deliver', wh: 1_500 }, // stops at 1,500, which looks like +400
    ]);
    expect([meter.physicalWh, meter.evidencedWh]).toEqual([1_650, 500]);
  });

  it('agrees with billing on every script, whatever order the readings arrive in', () => {
    // Two implementations of the same rule: the meter folds the clean log in emission order;
    // billing sorts whatever it was handed. They must agree.
    const scenario = fc.tuple(fc.nat({ max: 10_000_000 }), scripts).chain(([initialWh, script]) => {
      const played = play(initialWh, script);
      return fc.tuple(
        fc.constant(played),
        fc.shuffledSubarray(played.readings, { minLength: played.readings.length }),
      );
    });
    fc.assert(
      fc.property(scenario, ([{ meter, start, stop }, arrivalOrder]) => {
        expect(computeEnergyWh(start, arrivalOrder, stop).energyWh).toBe(meter.evidencedWh);
      }),
    );
  });

  it('never evidences more than flowed, and evidences all of it without hard resets', () => {
    fc.assert(
      fc.property(fc.nat({ max: 10_000_000 }), scripts, (initialWh, script) => {
        const { meter } = play(initialWh, script);
        expect(meter.evidencedWh).toBeLessThanOrEqual(meter.physicalWh);
        if (!script.some((step) => step.kind === 'hardReset')) {
          expect(meter.evidencedWh).toBe(meter.physicalWh);
        }
      }),
    );
  });
});
