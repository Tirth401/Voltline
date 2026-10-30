import { Prng } from '@voltline/common';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { DEFAULT_FAULTS, NO_FAULTS, planSession, shuffleQueue } from './faults.ts';

const anySeed = fc.integer({ min: 0, max: 0xffffffff });

describe('planSession', () => {
  it('makes the same plan from the same seed', () => {
    fc.assert(
      fc.property(anySeed, (seed) => {
        expect(planSession(new Prng(seed), DEFAULT_FAULTS)).toEqual(
          planSession(new Prng(seed), DEFAULT_FAULTS),
        );
      }),
    );
  });

  it('keeps offline spells and resets inside the session', () => {
    const always = { offline: 1, lostResponse: 0, dropAfterSend: 0, reorder: 0.5, meterReset: 1 };
    fc.assert(
      fc.property(anySeed, (seed) => {
        const plan = planSession(new Prng(seed), always);
        const { offline, reset } = plan;
        expect(offline).toBeDefined();
        expect(reset).toBeDefined();
        if (!offline || !reset) return;
        // Reconnecting at minutes + 2 at the latest means everything is delivered by the session's end.
        expect(0 <= offline.from && offline.from < offline.to).toBe(true);
        expect(offline.to).toBeLessThanOrEqual(plan.minutes + 2);
        expect(reset.afterMinute).toBeGreaterThanOrEqual(1);
        expect(reset.afterMinute).toBeLessThanOrEqual(plan.minutes);
      }),
    );
  });

  it('plans no faults at all with NO_FAULTS', () => {
    fc.assert(
      fc.property(anySeed, (seed) => {
        const plan = planSession(new Prng(seed), NO_FAULTS);
        expect(plan.offline).toBeUndefined();
        expect(plan.reset).toBeUndefined();
        expect(plan.shuffleOnReconnect).toBe(false);
      }),
    );
  });
});

describe('shuffleQueue', () => {
  it('keeps StartTransaction first and loses or adds nothing', () => {
    const queue = [
      { action: 'StartTransaction', id: 0 },
      ...Array.from({ length: 12 }, (_, i) => ({ action: 'MeterValues', id: i + 1 })),
      { action: 'StopTransaction', id: 13 },
    ];
    fc.assert(
      fc.property(anySeed, (seed) => {
        const shuffled = shuffleQueue(new Prng(seed), queue);
        expect(shuffled[0]).toEqual(queue[0]);
        expect(shuffled.map((message) => message.id).sort((a, b) => a - b)).toEqual(
          queue.map((message) => message.id),
        );
      }),
    );
  });
});
