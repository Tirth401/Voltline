import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ErrorObject, ValidateFunction } from 'ajv';
import AjvDraft04 from 'ajv-draft-04';
import ajvFormats from 'ajv-formats';
import type { OcppErrorCode } from '../errors.ts';
import { V16_ACTIONS, type V16Action } from './actions.ts';
import { V16_SCHEMA_DIR } from './schema-files.ts';

// Both packages are CommonJS with the real export on `.default`; this reads it the same way in
// Node and in TypeScript's NodeNext mode.
const Ajv = AjvDraft04.default;
const addFormats = ajvFormats.default;

export type ValidationResult =
  { ok: true } | { ok: false; errorCode: OcppErrorCode; description: string };

export interface V16Validator {
  /** Checks a CALL payload against `<Action>.json`. */
  request(action: V16Action, payload: unknown): ValidationResult;
  /** Checks a CALLRESULT payload against `<Action>Response.json`. */
  response(action: V16Action, payload: unknown): ValidationResult;
}

/**
 * Compiles every official OCPP 1.6 schema once (D-019).
 *
 * - The OCA schemas are JSON Schema draft-04, which plain Ajv 8 doesn't load, hence ajv-draft-04.
 * - `strict: false`: the files carry harmless quirks that Ajv's strict mode rejects, such as
 *   `additionalProperties` on a string enum. We don't edit the official files to please a library.
 * - `multipleOfPrecision`: charging limits must be multiples of 0.1, and in floating point
 *   0.3 / 0.1 = 2.9999999999999996. Without a tolerance, a valid 0.3 A limit would be rejected.
 */
export function createV16Validator(schemaDir: string = V16_SCHEMA_DIR): V16Validator {
  const ajv = new Ajv({ strict: false, allErrors: false, multipleOfPrecision: 9 });
  addFormats(ajv);

  const compiled = new Map<string, ValidateFunction>();
  for (const action of Object.keys(V16_ACTIONS)) {
    for (const name of [action, `${action}Response`]) {
      const schema = JSON.parse(readFileSync(join(schemaDir, `${name}.json`), 'utf8')) as object;
      compiled.set(name, ajv.compile(schema));
    }
  }

  const check = (schemaName: string, payload: unknown): ValidationResult => {
    const validate = compiled.get(schemaName);
    if (!validate) throw new Error(`no schema named ${schemaName}`);
    if (validate(payload)) return { ok: true };
    const error = validate.errors?.[0];
    return { ok: false, errorCode: toOcppErrorCode(error), description: describe(error) };
  };

  return {
    request: (action, payload) => check(action, payload),
    response: (action, payload) => check(`${action}Response`, payload),
  };
}

/** Maps the first schema failure onto the closest OCPP-J 1.6 error code. */
export function toOcppErrorCode(error: ErrorObject | undefined): OcppErrorCode {
  const keyword: string = error?.keyword ?? '';
  switch (keyword) {
    case 'required':
    case 'minItems':
    case 'maxItems':
      return 'OccurenceConstraintViolation';
    case 'type':
      return 'TypeConstraintViolation';
    case 'enum':
    case 'format':
    case 'maxLength':
    case 'minLength':
    case 'minimum':
    case 'maximum':
    case 'multipleOf':
    case 'pattern':
      return 'PropertyConstraintViolation';
    default:
      // additionalProperties and anything structural: the payload doesn't fit the PDU's shape.
      return 'FormationViolation';
  }
}

function describe(error: ErrorObject | undefined): string {
  if (!error) return 'payload does not match the schema';
  const where = error.instancePath === '' ? 'payload' : error.instancePath;
  const extra =
    error.keyword === 'additionalProperties'
      ? ` (${String((error.params as { additionalProperty?: unknown }).additionalProperty)})`
      : '';
  return `${where} ${error.message ?? 'is invalid'}${extra}`;
}
