// Starts the gateway: pnpm gateway (reads .env if present).
import { AvailabilityStore } from '@voltline/availability';
import { createPool } from '@voltline/db';
import { createV16Validator } from '@voltline/ocpp';
import { CommandBus, ConnectionRegistry } from '@voltline/routing';
import { Redis } from 'ioredis';
import { pino } from 'pino';
import { loadConfig } from './config.ts';
import { PostgresFrameLog } from './frame-log.ts';
import { createGateway } from './gateway.ts';

const config = loadConfig();
const logger = pino({ level: config.logLevel }).child({ gatewayId: config.gatewayId });
const db = createPool(config.databaseSchema === undefined ? {} : { schema: config.databaseSchema });
const redis = new Redis(config.redisUrl);
const frameLog = new PostgresFrameLog(db, logger);
const registry = new ConnectionRegistry(redis, config.redisPrefix);
const bus = new CommandBus(redis, registry, { keyPrefix: config.redisPrefix });

const gateway = createGateway({
  db,
  availability: new AvailabilityStore(redis, config.redisPrefix),
  validator: createV16Validator(),
  logger,
  frameLog,
  heartbeatIntervalSec: config.heartbeatIntervalSec,
  gatewayId: config.gatewayId,
  routing: { registry, bus },
});
const address = await gateway.listen(config.port, config.host);
logger.info(
  { port: address.port },
  `gateway listening: chargers connect to ws://${config.host}:${address.port}/ocpp/{chargePointId}`,
);

let stopping = false;
async function shutdown(signal: string): Promise<void> {
  if (stopping) return;
  stopping = true;
  logger.info({ signal }, 'shutting down');
  await gateway.close();
  await frameLog.flush();
  await bus.close();
  await Promise.allSettled([redis.quit(), db.end()]);
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    void shutdown(signal);
  });
}
