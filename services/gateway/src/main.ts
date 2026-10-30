// Starts the gateway: pnpm gateway (reads .env if present).
import { AvailabilityStore } from '@voltline/availability';
import { createPool } from '@voltline/db';
import { createV16Validator } from '@voltline/ocpp';
import { Redis } from 'ioredis';
import { pino } from 'pino';
import { loadConfig } from './config.ts';
import { PostgresFrameLog } from './frame-log.ts';
import { createGateway } from './gateway.ts';

const config = loadConfig();
const logger = pino({ level: config.logLevel });
const db = createPool();
const redis = new Redis(config.redisUrl);
const frameLog = new PostgresFrameLog(db, logger);

const gateway = createGateway({
  db,
  availability: new AvailabilityStore(redis),
  validator: createV16Validator(),
  logger,
  frameLog,
  heartbeatIntervalSec: config.heartbeatIntervalSec,
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
  await Promise.allSettled([redis.quit(), db.end()]);
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    void shutdown(signal);
  });
}
