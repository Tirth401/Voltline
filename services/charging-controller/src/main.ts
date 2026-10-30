// Runs the charging controller for one site: pnpm controller (reads .env if present).
// One controller per site, and only one: two would each think they own the site's spare power.
import { createServer } from 'node:http';
import { setTimeout as sleep } from 'node:timers/promises';
import { systemClock } from '@voltline/common';
import { createPool } from '@voltline/db';
import { CommandBus, ConnectionRegistry } from '@voltline/routing';
import { Redis } from 'ioredis';
import { pino } from 'pino';
import { createController } from './controller.ts';

const siteId = process.env['SITE_ID'] ?? 'SITE-DEMO';
const tickMs = Number(process.env['TICK_MS'] ?? 1_000);
const leaseMs = Number(process.env['LEASE_MS'] ?? 30_000);
const redisPrefix = process.env['REDIS_PREFIX'] ?? 'voltline:';
const schema = process.env['DATABASE_SCHEMA'] || undefined;
const healthPort = Number(process.env['HEALTH_PORT'] ?? 9240);

const logger = pino({ level: process.env['LOG_LEVEL'] ?? 'info' }).child({ siteId });
const db = createPool(schema === undefined ? {} : { schema });
const redis = new Redis(process.env['REDIS_URL'] ?? 'redis://localhost:6379');
const registry = new ConnectionRegistry(redis, redisPrefix);
const bus = new CommandBus(redis, registry, { keyPrefix: redisPrefix, timeoutMs: 10_000 });
const controller = createController({
  db,
  bus,
  registry,
  siteId,
  clock: systemClock,
  logger,
  leaseMs,
});

// Alive while the loop keeps coming round, even if its ticks fail: restarting the controller
// can't fix a database that is down, and a fresh one would have to wait out a lease (D-032). A
// tick that never returns is what this catches.
let lastLoopAt = performance.now();
const stalledAfterMs = Math.max(30_000, 10 * tickMs);
const health = createServer((request, response) => {
  const alive = performance.now() - lastLoopAt < stalledAfterMs;
  if (request.url !== '/healthz') response.writeHead(404).end();
  else response.writeHead(alive ? 200 : 503).end(alive ? 'ok\n' : 'stalled\n');
});
health.listen(healthPort);

let running = true;
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    running = false;
  });
}

logger.info(
  { tickMs, leaseMs },
  'charging controller started; sending nothing until old leases are over',
);
while (running) {
  try {
    const { sent } = await controller.tick();
    if (sent > 0) logger.debug({ sent }, 'sent limit changes');
  } catch (error) {
    logger.error({ err: error }, 'tick failed');
  }
  lastLoopAt = performance.now();
  await sleep(tickMs);
}
health.close();
await bus.close();
await Promise.allSettled([redis.quit(), db.end()]);
logger.info('charging controller stopped');
