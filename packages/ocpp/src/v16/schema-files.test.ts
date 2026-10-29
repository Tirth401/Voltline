import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { V16_ACTIONS } from './actions.ts';
import { checkV16SchemaDir, v16SchemaFileNames } from './schema-files.ts';

describe('OCPP 1.6 schema files', () => {
  const tempDirs: string[] = [];
  afterEach(() => {
    for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it('expects a request and a response schema for each of the 28 core actions', () => {
    expect(Object.keys(V16_ACTIONS)).toHaveLength(28);
    const names = v16SchemaFileNames();
    expect(names).toHaveLength(56);
    expect(names).toContain('BootNotification.json');
    expect(names).toContain('BootNotificationResponse.json');
  });

  it('reports exactly which files are missing and ignores extras', () => {
    const dir = mkdtempSync(join(tmpdir(), 'voltline-schemas-'));
    tempDirs.push(dir);
    for (const name of ['Heartbeat.json', 'HeartbeatResponse.json', 'README.md']) {
      writeFileSync(join(dir, name), '{}');
    }
    const result = checkV16SchemaDir(dir);
    expect(result.found).toBe(2);
    expect(result.missing).toHaveLength(54);
    expect(result.missing).not.toContain('Heartbeat.json');
    expect(result.missing).toContain('StartTransaction.json');
  });

  it('treats a missing folder as every file missing', () => {
    expect(checkV16SchemaDir('/nonexistent/voltline-schemas').missing).toHaveLength(56);
  });
});
