import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { migrate } from './migrate.ts';
import { createPool, DEFAULT_DATABASE_URL } from './pool.ts';

export interface TestDatabase {
  pool: Pool;
  schema: string;
  /** Closes the pool and drops the schema. Call it in afterAll. */
  drop(): Promise<void>;
}

/**
 * A fresh, fully migrated schema for one test file (D-014). Test files run in parallel without
 * sharing tables, and nothing a test writes survives into the next run.
 */
export async function createTestDatabase(): Promise<TestDatabase> {
  const schema = `test_${randomUUID().replaceAll('-', '').slice(0, 16)}`;
  await withAdminPool((admin) => admin.query(`CREATE SCHEMA ${schema}`));
  const pool = createPool({ schema, max: 4 });
  await migrate(pool);
  return {
    pool,
    schema,
    async drop() {
      await pool.end();
      await withAdminPool((admin) => admin.query(`DROP SCHEMA ${schema} CASCADE`));
    },
  };
}

async function withAdminPool<T>(work: (admin: Pool) => Promise<T>): Promise<T> {
  const admin = createPool({ max: 1 });
  try {
    return await work(admin);
  } catch (error) {
    if (isConnectionRefused(error)) {
      const url = process.env['DATABASE_URL'] ?? DEFAULT_DATABASE_URL;
      throw new Error(`Postgres isn't reachable at ${url}. Start it with: pnpm db:up`, {
        cause: error,
      });
    }
    throw error;
  } finally {
    await admin.end();
  }
}

function isConnectionRefused(error: unknown): boolean {
  if (error instanceof AggregateError) return error.errors.some(isConnectionRefused);
  return error instanceof Error && 'code' in error && error.code === 'ECONNREFUSED';
}
