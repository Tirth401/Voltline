import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { parseEnergyWh } from './meter-sample.ts';

describe('parseEnergyWh', () => {
  it.each([
    ['12345', 'Wh', 12_345],
    ['0', 'Wh', 0],
    ['007', 'Wh', 7],
    ['12.000', 'Wh', 12],
    [' 42 ', 'Wh', 42],
    ['12.345', 'kWh', 12_345],
    ['12.3', 'kWh', 12_300],
    ['12.3450', 'kWh', 12_345],
    ['0.001', 'kWh', 1],
    ['12', 'kWh', 12_000],
  ])('reads "%s" %s as %d Wh', (raw, unit, wh) => {
    expect(parseEnergyWh(raw, unit)).toBe(wh);
  });

  it.each([
    ['12.5', 'Wh'],
    ['0.0001', 'kWh'],
    ['-5', 'Wh'],
    ['1e3', 'Wh'],
    ['12,5', 'Wh'],
    ['', 'Wh'],
    ['abc', 'Wh'],
    ['5', 'kvarh'],
    ['9007199254740993', 'Wh'],
  ])('refuses "%s" %s', (raw, unit) => {
    expect(parseEnergyWh(raw, unit)).toBeUndefined();
  });

  it('reads back any whole number of Wh, written in Wh or in kWh', () => {
    fc.assert(
      fc.property(fc.maxSafeNat(), (wh) => {
        const kWh = `${Math.floor(wh / 1000)}.${String(wh % 1000).padStart(3, '0')}`;
        expect(parseEnergyWh(String(wh), 'Wh')).toBe(wh);
        expect(parseEnergyWh(kWh, 'kWh')).toBe(wh);
      }),
    );
  });
});
