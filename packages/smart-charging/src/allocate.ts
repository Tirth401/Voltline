/** What one connector needs from the site, in whole watts. */
export interface ConnectorDemand {
  /** e.g. "CP-0001/1": charger and connector. */
  key: string;
  /** What it may draw with no allocation at all: its TxDefaultProfile limit. */
  defaultW: number;
  /** The most it can deliver. */
  maxW: number;
  /** What the car plugged in wants right now; 0 when no car is charging. */
  demandW: number;
}

/**
 * Splits a site's power cap between its connectors (D-031).
 *
 * Every connector keeps its default limit, even when idle, because a car can plug in and start
 * drawing it at any moment without asking us first. The power left over is shared between the
 * cars that want more than their default, fairly: in each round, every car still wanting more
 * gets an equal share, until either the power or the wants run out. This is called max-min
 * fairness, or "water filling": no car gets more until every car wanting more has the same.
 *
 * Returns each connector's target limit. The targets never add up to more than the cap.
 */
export function allocate(
  capW: number,
  connectors: readonly ConnectorDemand[],
): Map<string, number> {
  const targets = new Map(connectors.map((c) => [c.key, c.defaultW]));
  const defaultsW = connectors.reduce((sum, c) => sum + c.defaultW, 0);
  let headroomW = capW - defaultsW;
  if (headroomW < 0) {
    throw new RangeError(
      `the connectors' defaults (${defaultsW} W) already exceed the site cap (${capW} W): ` +
        'an idle site could break the cap, so this configuration is refused',
    );
  }

  // Cars that want more than their default, in a fixed order so the result is deterministic.
  let wanting = connectors
    .map((c) => ({ key: c.key, moreW: Math.min(c.demandW, c.maxW) - c.defaultW }))
    .filter((w) => w.moreW > 0)
    .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));

  while (headroomW > 0 && wanting.length > 0) {
    const shareW = Math.floor(headroomW / wanting.length);
    if (shareW === 0) {
      // Fewer spare watts than cars: hand out the last few one by one, in key order.
      for (const w of wanting.slice(0, headroomW)) {
        targets.set(w.key, (targets.get(w.key) ?? 0) + 1);
      }
      break;
    }
    for (const w of wanting) {
      const giveW = Math.min(shareW, w.moreW);
      targets.set(w.key, (targets.get(w.key) ?? 0) + giveW);
      w.moreW -= giveW;
      headroomW -= giveW;
    }
    wanting = wanting.filter((w) => w.moreW > 0);
  }
  return targets;
}
