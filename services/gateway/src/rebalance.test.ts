import { Prng } from '@voltline/common';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_REBALANCE,
  planRebalance,
  type RebalanceSettings,
  type RebalanceState,
} from './rebalance.ts';

// Most cases look at a single round, so they act at once; patience has its own test.
const AT_ONCE: RebalanceSettings = { ...DEFAULT_REBALANCE, patienceRounds: 1 };
const shedding = (total = 0): RebalanceState => ({ shedding: true, total, roundsOver: 0 });

const plan = (
  gatewayId: string,
  counts: Record<string, number>,
  previous?: RebalanceState,
  settings: RebalanceSettings = AT_ONCE,
) =>
  planRebalance({
    gatewayId,
    loads: new Map(Object.entries(counts)),
    settings,
    ...(previous && { previous }),
  });

describe('planRebalance (D-039)', () => {
  it('sheds from the full gateways when one comes back empty, a round at a time', () => {
    const counts = { a: 1_000, b: 1_000, c: 0 };
    expect(plan('a', counts)).toMatchObject({ shedding: true, shed: 50 });
    expect(plan('b', counts)).toMatchObject({ shedding: true, shed: 50 });
    expect(plan('c', counts)).toMatchObject({ shedding: false, shed: 0 });
  });

  it('leaves the ordinary unevenness of random placement alone', () => {
    // Fair share 667; the slack is 10% of it, 67.
    expect(plan('a', { a: 720, b: 640, c: 640 })).toMatchObject({ shedding: false, shed: 0 });
    expect(plan('a', { a: 740, b: 630, c: 630 })).toMatchObject({ shedding: true, shed: 50 });
  });

  it('waits for the imbalance to last before moving anyone', () => {
    // A cold start: for a moment one gateway has more by chance. Moving chargers then would only
    // make them boot twice, so it takes three rounds in a row over the line.
    const counts = { a: 200, b: 60, c: 40 };
    const first = plan('a', counts, undefined, DEFAULT_REBALANCE);
    expect(first).toMatchObject({ shedding: false, shed: 0, roundsOver: 1 });
    const second = plan('a', counts, first, DEFAULT_REBALANCE);
    expect(second).toMatchObject({ shedding: false, shed: 0, roundsOver: 2 });
    expect(plan('a', counts, second, DEFAULT_REBALANCE)).toMatchObject({
      shedding: true,
      shed: 50,
    });
    // A round back inside the slack starts the count again.
    const evened = plan('a', { a: 110, b: 100, c: 90 }, second, DEFAULT_REBALANCE);
    expect(evened).toMatchObject({ shedding: false, roundsOver: 0 });
  });

  it('once shedding, keeps going down to the fair share, not just under the slack', () => {
    expect(plan('a', { a: 690, b: 655, c: 655 }, shedding())).toMatchObject({
      shedding: true,
      shed: 23,
    });
    expect(plan('a', { a: 667, b: 667, c: 666 }, shedding())).toMatchObject({
      shedding: false,
      shed: 0,
    });
  });

  it('counts chargers in flight between gateways, so it does not shed too many', () => {
    // A has been shedding; 300 of its chargers are reconnecting and in nobody's count yet. With
    // what it counts now (1,700), the fair share would look like 567 and A would go on below the
    // real 667. Its estimate of the total doesn't drop while it is shedding.
    const loads = { a: 700, b: 700, c: 300 };
    const decision = plan('a', loads, shedding(2_000));
    expect(decision).toMatchObject({ total: 2_000, shed: 33 });
    expect(Math.round(decision.fairShare)).toBe(667);
    // Done shedding: from then on the estimate is what everyone counts.
    expect(plan('a', { a: 667, b: 667, c: 640 }, shedding(2_000))).toMatchObject({
      total: 1_974,
      shedding: false,
      shed: 0,
    });
    // A gateway that wasn't shedding takes the count as it is.
    expect(plan('a', loads)).toMatchObject({ total: 1_700 });
  });

  it('never sheds when no other gateway has room, or when it is alone', () => {
    // A crashed gateway's last report still counts for a moment: nobody is below the fair share.
    expect(plan('a', { a: 1_000, b: 1_000, crashed: 1_000 })).toMatchObject({ shed: 0 });
    expect(plan('a', { a: 2_000 })).toMatchObject({ shedding: false, shed: 0 });
  });

  it('never sheds below the fair share, nor more than a round allows, nor without somewhere to go', () => {
    fc.assert(
      fc.property(
        fc.array(fc.nat({ max: 5_000 }), { minLength: 1, maxLength: 8 }),
        fc.record({
          shedding: fc.boolean(),
          total: fc.nat({ max: 40_000 }),
          roundsOver: fc.nat({ max: 5 }),
        }),
        fc.record({
          slackMin: fc.nat({ max: 100 }),
          slackRatio: fc.double({ min: 0, max: 0.5, noNaN: true }),
          maxShedPerRound: fc.integer({ min: 1, max: 200 }),
          patienceRounds: fc.integer({ min: 1, max: 5 }),
        }),
        (countList, previous, settings) => {
          const counts = Object.fromEntries(countList.map((count, i) => [`g${i}`, count]));
          const own = countList[0] ?? 0;
          const decision = plan('g0', counts, previous, settings);
          expect(decision.shed).toBeLessThanOrEqual(settings.maxShedPerRound);
          if (decision.shed > 0) {
            expect(own - decision.shed).toBeGreaterThanOrEqual(Math.ceil(decision.fairShare));
            expect(countList.slice(1).some((count) => count < decision.fairShare)).toBe(true);
          }
          // Starting to shed takes the full patience; carrying on doesn't.
          if (decision.shedding && !previous.shedding) {
            expect(previous.roundsOver + 1).toBeGreaterThanOrEqual(settings.patienceRounds);
          }
        },
      ),
    );
  });

  it('evens out a restarted gateway, moving each surplus charger about once', () => {
    // 2,000 chargers on three gateways, one just restarted and empty. Each round every gateway
    // decides from the round's counts; each charger it lets go reconnects to a random gateway,
    // and a gateway that is shedding turns it away, so it tries again. Seeded, so repeatable.
    const rng = new Prng(39);
    const counts: Record<string, number> = { a: 1_000, b: 1_000, c: 0 };
    const states: Record<string, RebalanceState | undefined> = {};
    let moved = 0;
    let refused = 0;
    let rounds = 0;
    for (; rounds < 60; rounds++) {
      const decisions = Object.keys(counts).map(
        (id) => [id, plan(id, counts, states[id], DEFAULT_REBALANCE)] as const,
      );
      const anyoneWaiting = decisions.some(([, decision]) => decision.roundsOver > 0);
      if (!anyoneWaiting && decisions.every(([, decision]) => decision.shed === 0)) break;
      for (const [id, decision] of decisions) {
        states[id] = decision;
        counts[id] = (counts[id] ?? 0) - decision.shed;
        moved += decision.shed;
      }
      const lettingIn = Object.keys(counts).filter((id) => states[id]?.shedding !== true);
      for (const [, decision] of decisions) {
        for (let i = 0; i < decision.shed; i++) {
          let landed = rng.pick(Object.keys(counts));
          while (!lettingIn.includes(landed)) {
            refused += 1;
            landed = rng.pick(Object.keys(counts));
          }
          counts[landed] = (counts[landed] ?? 0) + 1;
        }
      }
    }
    expect(counts).toEqual({ a: 667, b: 667, c: 666 });
    // The surplus was 666 chargers, 50 per gateway per round once patience ran out.
    expect(moved).toBe(666);
    expect(rounds).toBeLessThanOrEqual(11);
    expect(refused).toBeGreaterThan(0);
  });
});
