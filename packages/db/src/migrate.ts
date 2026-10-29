import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Pool } from 'pg';
import { withTransaction } from './transaction.ts';

export const MIGRATIONS_DIR = fileURLToPath(new URL('../migrations/', import.meta.url));

// Any constant works, as long as every process that migrates this database uses the same one.
const MIGRATION_LOCK_ID = 4_726_301;

/**
 * Applies pending migrations (`NNNN_name.sql`, in name order) and returns the versions it ran.
 *
 * Everything runs in one transaction under an advisory lock (D-012). Several gateway pods can start
 * at once and all call this: one migrates, the rest wait and then find nothing left to do. Postgres
 * DDL is transactional, so a failed migration leaves the database exactly as it was.
 */
export async function migrate(pool: Pool, dir: string = MIGRATIONS_DIR): Promise<string[]> {
  const files = (await readdir(dir)).filter((name) => name.endsWith('.sql')).sort();
  return withTransaction(pool, async (client) => {
    await client.query('SELECT pg_advisory_xact_lock($1)', [MIGRATION_LOCK_ID]);
    await client.query(
      `CREATE TABLE IF NOT EXISTS schema_migrations (
         version    text        PRIMARY KEY,
         applied_at timestamptz NOT NULL DEFAULT now()
       )`,
    );
    const { rows } = await client.query<{ version: string }>(
      'SELECT version FROM schema_migrations',
    );
    const applied = new Set(rows.map((row) => row.version));

    const ran: string[] = [];
    for (const file of files) {
      const version = file.slice(0, -'.sql'.length);
      if (applied.has(version)) continue;
      const sql = await readFile(join(dir, file), 'utf8');
      try {
        await client.query(sql);
      } catch (error) {
        throw new Error(`migration ${file} failed`, { cause: error });
      }
      await client.query('INSERT INTO schema_migrations (version) VALUES ($1)', [version]);
      ran.push(version);
    }
    return ran;
  });
}
