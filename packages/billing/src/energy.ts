/** One reading of the meter's energy register, in whole watt-hours, at the charger's timestamp. */
export interface RegisterReading {
  ts: Date;
  wh: number;
}

export interface EnergyResult {
  energyWh: number;
  /** How many times the register went down: each one is a meter reset (D-009). */
  resetsDetected: number;
}

/**
 * The energy a session delivered, as a pure function of its evidence (D-009).
 *
 * Readings are put in the charger's timestamp order, so the order they arrived in never matters,
 * and readings outside [start, stop] are ignored. Then for each neighbouring pair (a, b):
 * - b >= a: the meter advanced by b - a.
 * - b < a: the meter reset to zero in between, so only b is evidenced. Whatever flowed between
 *   the reading a and the reset was never reported, and isn't billed.
 *
 * With no reset this is simply stop - start, so lost, duplicated or reordered readings in between
 * can't change the answer. A reset is only visible if the next reading is lower than the last one.
 */
export function computeEnergyWh(
  start: RegisterReading,
  readings: readonly RegisterReading[],
  stop: RegisterReading,
): EnergyResult {
  const from = start.ts.getTime();
  const to = stop.ts.getTime();
  const between = readings
    .filter((reading) => reading.ts.getTime() >= from && reading.ts.getTime() <= to)
    .toSorted((x, y) => x.ts.getTime() - y.ts.getTime() || x.wh - y.wh);

  let energyWh = 0;
  let resetsDetected = 0;
  let previous = start.wh;
  for (const { wh } of [...between, stop]) {
    if (wh >= previous) {
      energyWh += wh - previous;
    } else {
      energyWh += wh;
      resetsDetected += 1;
    }
    previous = wh;
  }
  return { energyWh, resetsDetected };
}
