import pg from 'pg';
import type { Pool, PoolClient } from 'pg';

export const DEFAULT_DATABASE_URL = 'postgres://voltline:voltline@localhost:5432/voltline';

/** Anything you can run a query on: the pool itself, or one connection inside a transaction. */
export type Queryable = Pool | PoolClient;

// bigint columns (energy in Wh) come back as JS numbers instead of strings. Numbers are exact up to
// 2^53 Wh; a larger value throws rather than silently losing precision (D-007).
pg.types.setTypeParser(pg.types.builtins.INT8, (text: string) => {
  const value = Number(text);
  if (!Number.isSafeInteger(value)) {
    throw new RangeError(`bigint ${text} is too large to handle exactly`);
  }
  return value;
});

export interface PoolOptions {
  /** Defaults to $DATABASE_URL, then to the docker-compose database. */
  connectionString?: string;
  /** Create and look up tables in this schema first, then in `public`, where TimescaleDB lives. */
  schema?: string;
  max?: number;
}

export function createPool(options: PoolOptions = {}): Pool {
  return new pg.Pool({
    connectionString:
      options.connectionString ?? process.env['DATABASE_URL'] ?? DEFAULT_DATABASE_URL,
    max: options.max ?? 10,
    ...(options.schema === undefined ? {} : { options: `-c search_path=${options.schema},public` }),
  });
}
