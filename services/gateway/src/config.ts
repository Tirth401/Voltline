import { hostname } from 'node:os';

export interface GatewayConfig {
  /** Names this process among several gateways. */
  gatewayId: string;
  port: number;
  host: string;
  heartbeatIntervalSec: number;
  logLevel: string;
  redisUrl: string;
  /** Keys this gateway writes in Redis start with this, so test runs don't see each other. */
  redisPrefix: string;
  /** Postgres schema to use before `public`: tests give each run its own (D-014). */
  databaseSchema: string | undefined;
}

/** Gateway settings from environment variables. DATABASE_URL is read by @voltline/db. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): GatewayConfig {
  return {
    gatewayId: env['GATEWAY_ID'] ?? `${hostname()}-${process.pid}`,
    port: nonNegativeInteger('PORT', env['PORT'], 9220),
    host: env['HOST'] ?? '0.0.0.0',
    heartbeatIntervalSec: nonNegativeInteger(
      'HEARTBEAT_INTERVAL_S',
      env['HEARTBEAT_INTERVAL_S'],
      300,
    ),
    logLevel: env['LOG_LEVEL'] ?? 'info',
    redisUrl: env['REDIS_URL'] ?? 'redis://localhost:6379',
    redisPrefix: env['REDIS_PREFIX'] ?? 'voltline:',
    databaseSchema: env['DATABASE_SCHEMA'] || undefined,
  };
}

function nonNegativeInteger(name: string, value: string | undefined, fallback: number): number {
  if (value === undefined || value === '') return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`${name} must be a non-negative integer, got "${value}"`);
  }
  return parsed;
}
