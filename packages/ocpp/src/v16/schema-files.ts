import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { V16_ACTIONS } from './actions.ts';

/** Where the official OCPP 1.6 JSON schemas are vendored, unmodified. */
export const V16_SCHEMA_DIR = fileURLToPath(new URL('../../schemas/v1.6/', import.meta.url));

/** The Open Charge Alliance names each request schema `<Action>.json` and its response `<Action>Response.json`. */
export function v16SchemaFileNames(): string[] {
  return Object.keys(V16_ACTIONS).flatMap((action) => [`${action}.json`, `${action}Response.json`]);
}

export interface SchemaDirCheck {
  dir: string;
  found: number;
  missing: string[];
}

/** Reports which of the expected schema files are present. A missing folder counts as all missing. */
export function checkV16SchemaDir(dir: string = V16_SCHEMA_DIR): SchemaDirCheck {
  let present: Set<string>;
  try {
    present = new Set(readdirSync(dir));
  } catch {
    present = new Set();
  }
  const expected = v16SchemaFileNames();
  const missing = expected.filter((name) => !present.has(name));
  return { dir, found: expected.length - missing.length, missing };
}
