import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { allocate, type ConnectorDemand } from './allocate.ts';
import { nextChanges, siteWorstCaseW, type ConnectorState } from './controller.ts';

/** Everything that can happen to a site, in any order (D-031). */
type SiteEvent =
  | { kind: 'arrive'; index: number; demandW: number }
  | { kind: 'depart'; index: number }
  /** The charger answers the change in flight: applied it, refused it, or the answer was lost. */
  | { kind: 'answer'; index: number; outcome: 'accepted' | 'rejected' | 'lost' }
  | { kind: 'offline'; index: number }
  | { kind: 'online'; index: number }
  /** An offline charger's lease runs out, so it falls back to its default limit. */
  | { kind: 'leaseExpires'; index: number }
  /** The controller runs: recompute targets, send the next changes. */
  | { kind: 'step' };

const DEFAULT_W = 4_140; // 6 A on three phases at 230 V
const MAX_W = 22_000;

const events = (connectors: number): fc.Arbitrary<SiteEvent[]> => {
  const index = fc.integer({ min: 0, max: connectors - 1 });
  return fc.array(
    fc.oneof(
      fc.record({
        kind: fc.constant('arrive' as const),
        index,
        demandW: fc.integer({ min: 1_000, max: MAX_W }),
      }),
      fc.record({ kind: fc.constant('depart' as const), index }),
      fc.record({
        kind: fc.constant('answer' as const),
        index,
        outcome: fc.constantFrom('accepted' as const, 'rejected' as const, 'lost' as const),
      }),
      fc.record({ kind: fc.constant('offline' as const), index }),
      fc.record({ kind: fc.constant('online' as const), index }),
      fc.record({ kind: fc.constant('leaseExpires' as const), index }),
      fc.constant({ kind: 'step' as const }),
      fc.constant({ kind: 'step' as const }), // the controller runs often
    ),
    { maxLength: 300 },
  );
};

const scenario = fc.integer({ min: 2, max: 6 }).chain((connectors) =>
  fc.tuple(
    fc.constant(connectors),
    // The cap always fits every default, and is often far below what all the cars want.
    fc.integer({ min: connectors * DEFAULT_W, max: connectors * MAX_W }),
    events(connectors),
  ),
);

class Site {
  readonly capW: number;
  readonly connectors: ConnectorState[];
  readonly demandW: number[];

  constructor(capW: number, count: number) {
    this.capW = capW;
    this.connectors = Array.from({ length: count }, (_, i) => ({
      key: `CP-${i}/1`,
      defaultW: DEFAULT_W,
      acknowledgedW: DEFAULT_W, // every charger starts on its TxDefaultProfile
      online: true,
    }));
    this.demandW = Array.from({ length: count }, () => 0);
  }

  targets(): Map<string, number> {
    const demands: ConnectorDemand[] = this.connectors.map((c, i) => ({
      key: c.key,
      defaultW: c.defaultW,
      maxW: MAX_W,
      demandW: this.demandW[i] ?? 0,
    }));
    return allocate(this.capW, demands);
  }

  step(): number {
    const changes = nextChanges(this.capW, this.connectors, this.targets());
    for (const change of changes) {
      const connector = this.connectors.find((c) => c.key === change.key);
      if (connector) connector.inFlightW = change.limitW;
    }
    return changes.length;
  }

  apply(event: SiteEvent): void {
    if (event.kind === 'step') {
      this.step();
      return;
    }
    const connector = this.connectors[event.index];
    if (!connector) return;
    switch (event.kind) {
      case 'arrive':
        this.demandW[event.index] = event.demandW;
        break;
      case 'depart':
        this.demandW[event.index] = 0;
        break;
      case 'answer':
        if (connector.inFlightW === undefined) break;
        if (event.outcome === 'accepted') connector.acknowledgedW = connector.inFlightW;
        if (event.outcome !== 'lost') delete connector.inFlightW;
        break;
      case 'offline':
        connector.online = false;
        break;
      case 'online':
        connector.online = true;
        break;
      case 'leaseExpires':
        if (!connector.online) {
          connector.acknowledgedW = connector.defaultW;
          delete connector.inFlightW;
        }
        break;
    }
  }
}

describe('nextChanges', () => {
  it('sends decreases first, and the increase only once the decrease is confirmed', () => {
    const site = new Site(DEFAULT_W * 2 + 10_000, 2);
    site.demandW[0] = MAX_W;
    site.step();
    site.apply({ kind: 'answer', index: 0, outcome: 'accepted' });
    expect(site.connectors[0]?.acknowledgedW).toBe(DEFAULT_W + 10_000);

    // A second car arrives: the first must come down before the second may go up.
    site.demandW[1] = MAX_W;
    site.step();
    expect(site.connectors.map((c) => c.inFlightW)).toEqual([DEFAULT_W + 5_000, undefined]);
    expect(site.step()).toBe(0); // nothing more while the decrease is unconfirmed
    site.apply({ kind: 'answer', index: 0, outcome: 'accepted' });
    site.step();
    expect(site.connectors[1]?.inFlightW).toBe(DEFAULT_W + 5_000);
  });

  it('never lets the worst case exceed the cap, whatever happens and in whatever order', () => {
    fc.assert(
      fc.property(scenario, ([count, capW, script]) => {
        const site = new Site(capW, count);
        for (const event of script) {
          site.apply(event);
          expect(siteWorstCaseW(site.connectors)).toBeLessThanOrEqual(capW);
        }
      }),
    );
  });

  it('reaches the targets once chargers are back online and answering', () => {
    fc.assert(
      fc.property(scenario, ([count, capW, script]) => {
        const site = new Site(capW, count);
        for (const event of script) site.apply(event);

        // Things calm down: everyone comes back and every change is accepted.
        for (const connector of site.connectors) connector.online = true;
        for (let round = 0; round < 20; round++) {
          for (let i = 0; i < count; i++)
            site.apply({ kind: 'answer', index: i, outcome: 'accepted' });
          if (site.step() === 0 && site.connectors.every((c) => c.inFlightW === undefined)) break;
          expect(siteWorstCaseW(site.connectors)).toBeLessThanOrEqual(capW);
        }
        const targets = site.targets();
        for (const connector of site.connectors) {
          expect(connector.inFlightW).toBeUndefined();
          expect(connector.acknowledgedW).toBe(targets.get(connector.key));
        }
      }),
    );
  });
});
