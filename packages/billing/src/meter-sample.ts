/**
 * One sampled value as the charger reported it, with OCPP 1.6's defaults already applied
 * (measurand Energy.Active.Import.Register, location Outlet, unit Wh, no phase).
 */
export interface MeterSample {
  ts: Date;
  measurand: string;
  /** '' when the value covers all phases. */
  phase: string;
  location: string;
  context: string;
  unit: string;
  /** Exactly the string the charger sent. */
  rawValue: string;
}

/**
 * Parses a meter value into whole watt-hours, exactly, without going through a float (D-007).
 *
 * Accepts plain non-negative decimals in Wh or kWh. Returns undefined for anything else: other
 * units, signs, exponents, or precision finer than 1 Wh, which we can't bill without rounding.
 */
export function parseEnergyWh(rawValue: string, unit: string): number | undefined {
  const scale = unit === 'Wh' ? 0 : unit === 'kWh' ? 3 : undefined;
  if (scale === undefined) return undefined;
  const match = /^(\d+)(?:\.(\d+))?$/.exec(rawValue.trim());
  if (!match) return undefined;
  const whole = match[1] ?? '';
  const significantFraction = (match[2] ?? '').replace(/0+$/, '');
  if (significantFraction.length > scale) return undefined;
  const value = Number(whole + significantFraction.padEnd(scale, '0'));
  return Number.isSafeInteger(value) ? value : undefined;
}
