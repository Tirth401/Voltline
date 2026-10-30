// Settles stopped sessions whose evidence has gone quiet: pnpm settle (reads .env if present).
// Safe to run anywhere, and more than once at a time (D-034). With --once it makes one pass and
// exits, which is how a Kubernetes CronJob would run it.
import { setTimeout as sleep } from 'node:timers/promises';
import { parseArgs } from 'node:util';
import { settleDueSessions } from '@voltline/billing';
import { createPool } from '@voltline/db';
import { pino } from 'pino';

const { values } = parseArgs({ options: { once: { type: 'boolean', default: false } } });
const quietMs = Number(process.env['SETTLE_QUIET_MS'] ?? 15 * 60_000);
const everyMs = Number(process.env['SETTLE_EVERY_MS'] ?? 60_000);
const schema = process.env['DATABASE_SCHEMA'] || undefined;

const logger = pino({ level: process.env['LOG_LEVEL'] ?? 'info' });
const db = createPool(schema === undefined ? {} : { schema });
const stopping = new AbortController();
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    stopping.abort();
  });
}

async function settleOnce(): Promise<boolean> {
  try {
    const settled = await settleDueSessions(db, { quietMs });
    if (settled > 0) logger.info({ settled }, 'settled sessions');
    return true;
  } catch (error) {
    logger.error({ err: error }, 'settlement pass failed');
    return false;
  }
}

logger.info({ quietMs, everyMs, once: values.once }, 'settlement started');
if (values.once) {
  if (!(await settleOnce())) process.exitCode = 1;
} else {
  while (!stopping.signal.aborted) {
    await settleOnce();
    await sleep(everyMs, undefined, { signal: stopping.signal }).catch(() => undefined);
  }
}
await db.end();
logger.info('settlement stopped');
