import type { Pool, PoolClient } from 'pg';

/** Runs `work` between BEGIN and COMMIT on one connection, and rolls back if it throws. */
export async function withTransaction<T>(
  pool: Pool,
  work: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await work(client);
    await client.query('COMMIT');
    client.release();
    return result;
  } catch (error) {
    const rolledBack = await client.query('ROLLBACK').then(
      () => true,
      () => false,
    );
    // A connection we couldn't roll back is in an unknown state: destroy it rather than reuse it.
    client.release(!rolledBack);
    throw error;
  }
}
