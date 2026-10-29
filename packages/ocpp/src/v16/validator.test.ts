import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import AjvDraft04 from 'ajv-draft-04';
import { describe, expect, it } from 'vitest';
import { V16_SCHEMA_DIR } from './schema-files.ts';
import { createV16Validator } from './validator.ts';

// These tests run against the real, vendored OCA schemas.
const validator = createV16Validator();

const boot = { chargePointVendor: 'Voltline', chargePointModel: 'Sim-1' };

describe('V16 validator', () => {
  it('accepts a valid request and a valid response', () => {
    expect(validator.request('BootNotification', boot)).toEqual({ ok: true });
    expect(
      validator.response('BootNotification', {
        status: 'Accepted',
        currentTime: '2026-01-01T00:00:00.000Z',
        interval: 300,
      }),
    ).toEqual({ ok: true });
  });

  it('maps each kind of schema failure to its OCPP-J 1.6 error code', () => {
    const cases: [unknown, string][] = [
      [{ chargePointVendor: 'Voltline' }, 'OccurenceConstraintViolation'],
      [{ ...boot, chargePointVendor: 42 }, 'TypeConstraintViolation'],
      [{ ...boot, chargePointVendor: 'x'.repeat(21) }, 'PropertyConstraintViolation'],
      [{ ...boot, colour: 'blue' }, 'FormationViolation'],
    ];
    for (const [payload, errorCode] of cases) {
      expect(validator.request('BootNotification', payload)).toMatchObject({
        ok: false,
        errorCode,
      });
    }
  });

  it('rejects bad enum values and malformed timestamps as property violations', () => {
    expect(
      validator.request('StatusNotification', {
        connectorId: 1,
        errorCode: 'NoError',
        status: 'Sleeping',
      }),
    ).toMatchObject({ ok: false, errorCode: 'PropertyConstraintViolation' });
    expect(
      validator.request('StartTransaction', {
        connectorId: 1,
        idTag: 'TAG-1',
        meterStart: 0,
        timestamp: 'yesterday',
      }),
    ).toMatchObject({ ok: false, errorCode: 'PropertyConstraintViolation' });
  });

  it('says which field broke the schema', () => {
    const result = validator.request('BootNotification', { ...boot, colour: 'blue' });
    expect(result).toMatchObject({
      ok: false,
      description: 'payload must NOT have additional properties (colour)',
    });
  });

  describe('charging limits (multiples of 0.1)', () => {
    const profile = (limit: number): unknown => ({
      connectorId: 1,
      csChargingProfiles: {
        chargingProfileId: 1,
        stackLevel: 0,
        chargingProfilePurpose: 'TxDefaultProfile',
        chargingProfileKind: 'Absolute',
        chargingSchedule: {
          chargingRateUnit: 'A',
          chargingSchedulePeriod: [{ startPeriod: 0, limit }],
        },
      },
    });

    it('accepts 0.3, even though 0.3 / 0.1 is 2.9999999999999996 in floating point', () => {
      expect(validator.request('SetChargingProfile', profile(0.3))).toEqual({ ok: true });
      expect(validator.request('SetChargingProfile', profile(16.1))).toEqual({ ok: true });
    });

    it('still rejects values that are not multiples of 0.1', () => {
      expect(validator.request('SetChargingProfile', profile(0.35))).toMatchObject({
        ok: false,
        errorCode: 'PropertyConstraintViolation',
      });
    });

    it('needs multipleOfPrecision: a default Ajv rejects the valid 0.3', () => {
      const plain = new AjvDraft04.default({ strict: false });
      const schema = JSON.parse(
        readFileSync(join(V16_SCHEMA_DIR, 'SetChargingProfile.json'), 'utf8'),
      ) as object;
      expect(plain.validate(schema, profile(0.3))).toBe(false);
    });
  });
});
