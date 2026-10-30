import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { allocate, type ConnectorDemand } from './allocate.ts';

/** A site whose defaults fit under its cap, with cars wanting anything from nothing to plenty. */
const site = fc
  .array(
    fc.record({
      defaultW: fc.integer({ min: 0, max: 5_000 }),
      maxW: fc.integer({ min: 0, max: 50_000 }),
      demandW: fc.integer({ min: 0, max: 60_000 }),
    }),
    { minLength: 1, maxLength: 12 },
  )
  .chain((specs) => {
    const connectors: ConnectorDemand[] = specs.map((spec, i) => ({
      key: `CP-${String(i).padStart(2, '0')}/1`,
      ...spec,
    }));
    const defaultsW = connectors.reduce((sum, c) => sum + c.defaultW, 0);
    return fc.tuple(
      fc.integer({ min: defaultsW, max: defaultsW + 200_000 }),
      fc.constant(connectors),
    );
  });

const wantW = (c: ConnectorDemand): number => Math.max(c.defaultW, Math.min(c.demandW, c.maxW));

describe('allocate', () => {
  it('shares the spare power fairly between the cars that want more', () => {
    // 22 kW site, three connectors with a 4,140 W default (6 A on three phases), two cars wanting 11 kW.
    const connector = (key: string, demandW: number): ConnectorDemand => ({
      key,
      defaultW: 4_140,
      maxW: 11_000,
      demandW,
    });
    const targets = allocate(22_000, [
      connector('A', 11_000),
      connector('B', 11_000),
      connector('C', 0),
    ]);
    // 22,000 - 3 × 4,140 = 9,580 W spare, split evenly: 4,790 W more each for A and B.
    expect(Object.fromEntries(targets)).toEqual({ A: 8_930, B: 8_930, C: 4_140 });
  });

  it('never hands out more than the cap, and never less than a default', () => {
    fc.assert(
      fc.property(site, ([capW, connectors]) => {
        const targets = allocate(capW, connectors);
        const total = connectors.reduce((sum, c) => sum + (targets.get(c.key) ?? 0), 0);
        expect(total).toBeLessThanOrEqual(capW);
        for (const c of connectors) {
          const target = targets.get(c.key) ?? 0;
          expect(target).toBeGreaterThanOrEqual(c.defaultW);
          expect(target).toBeLessThanOrEqual(wantW(c));
        }
      }),
    );
  });

  it('wastes nothing: either every car gets what it wants, or the whole cap is used', () => {
    fc.assert(
      fc.property(site, ([capW, connectors]) => {
        const targets = allocate(capW, connectors);
        const total = connectors.reduce((sum, c) => sum + (targets.get(c.key) ?? 0), 0);
        const everyoneSatisfied = connectors.every((c) => targets.get(c.key) === wantW(c));
        expect(everyoneSatisfied || total === capW).toBe(true);
      }),
    );
  });

  it('is fair: two cars both still short of what they want differ by at most 1 W extra', () => {
    fc.assert(
      fc.property(site, ([capW, connectors]) => {
        const targets = allocate(capW, connectors);
        const extras = connectors
          .filter((c) => (targets.get(c.key) ?? 0) < wantW(c))
          .map((c) => (targets.get(c.key) ?? 0) - c.defaultW);
        if (extras.length > 1) {
          expect(Math.max(...extras) - Math.min(...extras)).toBeLessThanOrEqual(1);
        }
      }),
    );
  });

  it('refuses a site whose defaults alone exceed the cap', () => {
    const idle = { defaultW: 4_140, maxW: 11_000, demandW: 0 };
    expect(() =>
      allocate(8_000, [
        { key: 'A', ...idle },
        { key: 'B', ...idle },
      ]),
    ).toThrow(RangeError);
  });
});
