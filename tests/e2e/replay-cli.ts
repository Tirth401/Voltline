// Replays one charger's recorded frames from a kept schema into a fresh one, and prints both bills
// side by side. Usage: pnpm replay --schema test_1a2b3c4d --charger CP-0007
import { parseArgs } from 'node:util';
import { AvailabilityStore } from '@voltline/availability';
import { createTestRedis, deleteKeysWithPrefix } from '@voltline/availability/testing';
import { createPool } from '@voltline/db';
import { createTestDatabase } from '@voltline/db/testing';
import { loadRecordedCalls, replayCalls } from '@voltline/gateway';
import { pino } from 'pino';
import { validator } from './harness.ts';

const { values } = parseArgs({
  options: { schema: { type: 'string' }, charger: { type: 'string' } },
});
if (!values.schema || !values.charger) {
  console.error('usage: pnpm replay --schema <kept schema> --charger <chargePointId>');
  process.exit(2);
}
const chargePointId = values.charger;

const source = createPool({ schema: values.schema, max: 2 });
const target = await createTestDatabase();
const redis = createTestRedis();
const redisPrefix = `voltline-replay-${target.schema}:`;
try {
  await target.pool.query('INSERT INTO charge_points (id) VALUES ($1)', [chargePointId]);
  const { rows: tags } = await source.query<{ id_tag: string; status: string }>(
    'SELECT id_tag, status FROM id_tags',
  );
  for (const tag of tags) {
    await target.pool.query('INSERT INTO id_tags (id_tag, status) VALUES ($1, $2)', [
      tag.id_tag,
      tag.status,
    ]);
  }

  const calls = await loadRecordedCalls(source, chargePointId);
  const result = await replayCalls({
    chargePointId,
    calls,
    db: target.pool,
    availability: new AvailabilityStore(redis, redisPrefix),
    validator,
    logger: pino({ level: 'warn' }),
  });
  console.log(
    `Replayed ${result.replayed} CALLs from ${chargePointId} (${result.answeredWithError} answered with an error).`,
  );

  interface Bill {
    started_at: Date;
    energy_wh: number | null;
    state: string;
  }
  const sql = `SELECT started_at, energy_wh, state
                 FROM transactions WHERE charge_point_id = $1 ORDER BY started_at`;
  const original = (await source.query<Bill>(sql, [chargePointId])).rows;
  const replayed = new Map(
    (await target.pool.query<Bill>(sql, [chargePointId])).rows.map((bill) => [
      bill.started_at.toISOString(),
      bill,
    ]),
  );
  console.table(
    original.map((bill) => ({
      startedAt: bill.started_at.toISOString(),
      billedWh: bill.energy_wh,
      replayedWh: replayed.get(bill.started_at.toISOString())?.energy_wh ?? 'missing',
      state: bill.state,
    })),
  );
} finally {
  await deleteKeysWithPrefix(redis, redisPrefix);
  await redis.quit();
  await source.end();
  await target.drop();
}
