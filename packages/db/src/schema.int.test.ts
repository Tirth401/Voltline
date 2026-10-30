import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { migrate } from './migrate.ts';
import { createTestDatabase, type TestDatabase } from './testing.ts';

let db: TestDatabase;

beforeAll(async () => {
  db = await createTestDatabase();
  await db.pool.query(`INSERT INTO charge_points (id) VALUES ('CP-1')`);
});

afterAll(async () => {
  await db.drop();
});

describe('migrations', () => {
  it('create every table', async () => {
    const { rows } = await db.pool.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables
        WHERE table_schema = $1 ORDER BY table_name`,
      [db.schema],
    );
    expect(rows.map((row) => row.table_name)).toEqual([
      'bill_corrections',
      'charge_points',
      'id_tags',
      'meter_readings',
      'ocpp_frames',
      'schema_migrations',
      'sites',
      'transactions',
    ]);
  });

  it('make meter_readings and ocpp_frames TimescaleDB hypertables', async () => {
    const { rows } = await db.pool.query<{ hypertable_name: string }>(
      `SELECT hypertable_name FROM timescaledb_information.hypertables
        WHERE hypertable_schema = $1 ORDER BY hypertable_name`,
      [db.schema],
    );
    expect(rows.map((row) => row.hypertable_name)).toEqual(['meter_readings', 'ocpp_frames']);
  });

  it('are safe to run again, even from two places at once', async () => {
    await expect(Promise.all([migrate(db.pool), migrate(db.pool)])).resolves.toEqual([[], []]);
  });
});

describe('transactions', () => {
  const insertStart = `
    INSERT INTO transactions (charge_point_id, connector_id, id_tag, auth_status, started_at, meter_start_wh)
    VALUES ($1, $2, $3, $4, $5, $6)
    ON CONFLICT ON CONSTRAINT start_idempotency DO NOTHING
    RETURNING transaction_id`;

  it('let a retried StartTransaction find the original session instead of creating a second', async () => {
    const start = ['CP-1', 1, 'TAG-1', 'Accepted', '2026-01-01T10:00:00Z', 10_000];
    const first = await db.pool.query(insertStart, start);
    const retry = await db.pool.query(insertStart, start);
    expect(first.rowCount).toBe(1);
    expect(retry.rowCount).toBe(0); // the gateway then selects the existing transactionId
    const { rows } = await db.pool.query<{ sessions: number }>(
      `SELECT count(*)::int AS sessions FROM transactions WHERE charge_point_id = 'CP-1'`,
    );
    expect(rows[0]?.sessions).toBe(1);
  });

  it('keep transactionId within int32 (D-007)', async () => {
    const { rows } = await db.pool.query<{ data_type: string }>(
      `SELECT data_type FROM information_schema.columns
        WHERE table_schema = $1 AND table_name = 'transactions' AND column_name = 'transaction_id'`,
      [db.schema],
    );
    expect(rows[0]?.data_type).toBe('integer');
  });

  it('refuse to mark a session settled without the bill it settled with (D-034)', async () => {
    const start = ['CP-1', 2, 'TAG-1', 'Accepted', '2026-01-01T11:00:00Z', 0];
    const { rows } = await db.pool.query<{ transaction_id: number }>(insertStart, start);
    await expect(
      db.pool.query(`UPDATE transactions SET state = 'settled' WHERE transaction_id = $1`, [
        rows[0]?.transaction_id,
      ]),
    ).rejects.toThrow('settled_bill_is_kept');
  });
});

describe('meter_readings', () => {
  it('store one value per meter per instant, so a resent reading is dropped', async () => {
    const insertReading = `
      INSERT INTO meter_readings (charge_point_id, connector_id, transaction_id, ts, raw_value, value_wh)
      VALUES ('CP-1', 1, 1, '2026-01-01T10:05:00Z', '10250', 10250)
      ON CONFLICT ON CONSTRAINT one_value_per_instant DO NOTHING`;
    await db.pool.query(insertReading);
    await db.pool.query(insertReading);
    const { rows } = await db.pool.query<{ readings: number }>(
      `SELECT count(*)::int AS readings FROM meter_readings WHERE charge_point_id = 'CP-1'`,
    );
    expect(rows[0]?.readings).toBe(1);
  });
});
