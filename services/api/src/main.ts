// Starts the REST API: pnpm api (reads .env if present).
import { AvailabilityStore } from '@voltline/availability';
import { createPool } from '@voltline/db';
import { CommandBus, ConnectionRegistry } from '@voltline/routing';
import { Redis } from 'ioredis';
import { pino } from 'pino';
import { createApi } from './api.ts';

const port = Number(process.env['PORT'] ?? 9230);
const host = process.env['HOST'] ?? '0.0.0.0';
const redisPrefix = process.env['REDIS_PREFIX'] ?? 'voltline:';
const schema = process.env['DATABASE_SCHEMA'] || undefined;

const logger = pino({ level: process.env['LOG_LEVEL'] ?? 'info' });
const db = createPool(schema === undefined ? {} : { schema });
const redis = new Redis(process.env['REDIS_URL'] ?? 'redis://localhost:6379');
const registry = new ConnectionRegistry(redis, redisPrefix);
const bus = new CommandBus(redis, registry, { keyPrefix: redisPrefix });

const api = createApi({
  db,
  availability: new AvailabilityStore(redis, redisPrefix),
  registry,
  bus,
  logger,
});
const address = await api.listen(port, host);
logger.info({ port: address.port }, `api listening on http://${host}:${address.port}`);

let stopping = false;
async function shutdown(signal: string): Promise<void> {
  if (stopping) return;
  stopping = true;
  logger.info({ signal }, 'shutting down');
  await api.close();
  await bus.close();
  await Promise.allSettled([redis.quit(), db.end()]);
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    void shutdown(signal);
  });
}
