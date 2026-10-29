import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { Prng } from './prng.ts';

const take = (count: number, next: () => number): number[] => Array.from({ length: count }, next);
const anySeed = fc.integer({ min: 0, max: 0xffffffff });

describe('Prng', () => {
  it('produces the recorded sequence for a known seed', () => {
    // If this fails, the generator changed, and every seed in every saved scenario now means
    // something different. Change it only on purpose, and say so in DECISIONS.md.
    const prng = new Prng(42);
    expect(take(5, () => prng.nextUint32())).toEqual([
      853279530, 1920286840, 3588795744, 3644712829, 3990689672,
    ]);
  });

  it('gives the same sequence for the same seed', () => {
    fc.assert(
      fc.property(anySeed, (seed) => {
        const first = new Prng(seed);
        const second = new Prng(seed);
        expect(take(50, () => first.nextUint32())).toEqual(take(50, () => second.nextUint32()));
      }),
    );
  });

  describe('fork', () => {
    it('derives the recorded child stream', () => {
      const child = new Prng(42).fork('charger-17');
      expect(child.seed).toBe(1675942788);
      expect(take(3, () => child.nextUint32())).toEqual([1206084138, 2476799455, 3878087829]);
    });

    it('ignores how many numbers the parent has drawn', () => {
      const fresh = new Prng(42);
      const used = new Prng(42);
      take(1_000, () => used.nextUint32());
      expect(used.fork('charger-17').seed).toBe(fresh.fork('charger-17').seed);
    });

    it('gives each of 2,000 chargers its own stream', () => {
      const parent = new Prng(42);
      const seeds = new Set(
        Array.from({ length: 2_000 }, (_, i) => parent.fork(`charger-${i}`).seed),
      );
      expect(seeds.size).toBe(2_000);
    });
  });

  describe('int', () => {
    it('stays within [min, max] for any seed and range', () => {
      fc.assert(
        fc.property(
          anySeed,
          fc.integer({ min: -1_000_000, max: 1_000_000 }),
          fc.integer({ min: 0, max: 1_000_000 }),
          (seed, min, width) => {
            const value = new Prng(seed).int(min, min + width);
            expect(Number.isInteger(value)).toBe(true);
            expect(value).toBeGreaterThanOrEqual(min);
            expect(value).toBeLessThanOrEqual(min + width);
          },
        ),
      );
    });

    it('produces the recorded dice rolls for seed 7', () => {
      const prng = new Prng(7);
      expect(take(12, () => prng.int(1, 6))).toEqual([4, 2, 4, 3, 6, 5, 1, 2, 1, 2, 2, 2]);
    });

    it('handles the full 32-bit span', () => {
      const value = new Prng(1).int(0, 2 ** 32 - 1);
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThan(2 ** 32);
    });
  });

  it('shuffles into a permutation of the input and leaves the input alone', () => {
    fc.assert(
      fc.property(anySeed, fc.array(fc.integer()), (seed, items) => {
        const original = [...items];
        const shuffled = new Prng(seed).shuffle(items);
        expect(items).toEqual(original);
        const byValue = (x: number, y: number): number => x - y;
        expect([...shuffled].sort(byValue)).toEqual([...items].sort(byValue));
      }),
    );
  });

  it('never fires chance(0) and always fires chance(1)', () => {
    const prng = new Prng(3);
    for (let i = 0; i < 1_000; i++) {
      expect(prng.chance(0)).toBe(false);
      expect(prng.chance(1)).toBe(true);
    }
  });

  it('rejects bad arguments', () => {
    expect(() => new Prng(-1)).toThrow(RangeError);
    expect(() => new Prng(2 ** 32)).toThrow(RangeError);
    expect(() => new Prng(1.5)).toThrow(RangeError);
    const prng = new Prng(1);
    expect(() => prng.int(5, 4)).toThrow(RangeError);
    expect(() => prng.chance(1.01)).toThrow(RangeError);
    expect(() => prng.pick([])).toThrow(RangeError);
  });
});
