import { randomUUID } from 'node:crypto';
import { createTestRedis, deleteKeysWithPrefix } from '@voltline/availability/testing';
import fc from 'fast-check';
import type { Redis } from 'ioredis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BootBudget, retryIntervalSeconds } from './boot-budget.ts';

let redis: Redis;
const prefixes: string[] = [];
const T = 1_800_000_000_000; // a fixed "now", in ms, passed in instead of Redis's clock

const freshBudget = (ratePerSecond: number, burst: number): BootBudget => {
  const keyPrefix = `voltline-test-${randomUUID()}:`;
  prefixes.push(keyPrefix);
  return new BootBudget(redis, { ratePerSecond, burst, keyPrefix });
};

beforeAll(() => {
  redis = createTestRedis();
});

afterAll(async () => {
  for (const prefix of prefixes) await deleteKeysWithPrefix(redis, prefix);
  await redis.quit();
});

describe('BootBudget (D-038)', () => {
  it('lets a burst in at once, then gives the rest appointments at the budget rate', async () => {
    const budget = freshBudget(10, 5); // one boot every 100 ms, five at once
    const answers = [];
    for (let i = 1; i <= 25; i++) answers.push(await budget.admit(`CP-${i}`, T));
    expect(answers.slice(0, 5)).toEqual(Array(5).fill({ accepted: true }));
    // The 6th may come back after 100 ms, the 7th after 200 ms… the 25th after 2 s.
    expect(answers.slice(5)).toEqual(
      Array.from({ length: 20 }, (_, i) => ({ accepted: false, waitMs: (i + 1) * 100 })),
    );
  });

  it('lets a charger in when it comes back for its appointment, and keeps its place if early', async () => {
    const budget = freshBudget(10, 1);
    expect(await budget.admit('CP-A', T)).toEqual({ accepted: true });
    expect(await budget.admit('CP-B', T)).toEqual({ accepted: false, waitMs: 100 });
    expect(await budget.admit('CP-C', T)).toEqual({ accepted: false, waitMs: 200 });
    // C comes back too early: same appointment, not the back of the queue.
    expect(await budget.admit('CP-C', T + 150)).toEqual({ accepted: false, waitMs: 50 });
    // B comes back on time and is let in without taking a new place: D still gets 300 ms.
    expect(await budget.admit('CP-B', T + 100)).toEqual({ accepted: true });
    expect(await budget.admit('CP-D', T + 100)).toEqual({ accepted: false, waitMs: 200 });
    expect(await budget.admit('CP-C', T + 200)).toEqual({ accepted: true });
  });

  it('refills after a quiet spell', async () => {
    const budget = freshBudget(10, 3);
    for (const id of ['CP-1', 'CP-2', 'CP-3']) {
      expect(await budget.admit(id, T)).toEqual({ accepted: true });
    }
    expect((await budget.admit('CP-4', T)).accepted).toBe(false);
    // 400 ms later CP-4's place has come up, and three more places have refilled.
    expect(await budget.admit('CP-4', T + 400)).toEqual({ accepted: true });
    for (const id of ['CP-5', 'CP-6', 'CP-7']) {
      expect(await budget.admit(id, T + 700)).toEqual({ accepted: true });
    }
  });

  it('turns a wait into OCPP whole seconds, never 0', () => {
    expect([1, 999, 1_000, 1_001, 2_500].map(retryIntervalSeconds)).toEqual([1, 1, 1, 2, 3]);
  });

  it('never runs ahead of the budget, and lets every charger in, whatever the arrivals', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 1, max: 40 }),
        fc.integer({ min: 1, max: 15 }),
        fc.array(fc.integer({ min: 0, max: 5_000 }), { minLength: 1, maxLength: 60 }),
        async (ratePerSecond, burst, arrivals) => {
          const budget = freshBudget(ratePerSecond, burst);
          // Each charger boots when it arrives, and again whenever it was told to wait: exactly
          // `interval` whole seconds later, as OCPP 1.6 says.
          const events = arrivals.map((atMs, i) => ({ atMs, id: `CP-${i}`, returning: false }));
          const accepted: number[] = [];
          while (events.length > 0) {
            events.sort((a, b) => a.atMs - b.atMs);
            const event = events.shift();
            if (!event) break;
            const answer = await budget.admit(event.id, T + event.atMs);
            if (answer.accepted) {
              accepted.push(event.atMs);
            } else {
              // A charger that comes back as told is never turned away a second time.
              expect(event.returning).toBe(false);
              const seconds = retryIntervalSeconds(answer.waitMs);
              events.push({ atMs: event.atMs + seconds * 1_000, id: event.id, returning: true });
            }
          }
          expect(accepted).toHaveLength(arrivals.length);
          // By any moment, no more than the burst plus the rate times the time since the first
          // arrival can have been let in.
          const first = Math.min(...arrivals);
          accepted.forEach((atMs, i) => {
            expect(i + 1).toBeLessThanOrEqual(burst + (ratePerSecond * (atMs - first)) / 1_000);
          });
        },
      ),
      { numRuns: 60 },
    );
  });
});
