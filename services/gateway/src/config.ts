export interface GatewayConfig {
  port: number;
  host: string;
  heartbeatIntervalSec: number;
  logLevel: string;
  redisUrl: string;
}

/** Gateway settings from environment variables. DATABASE_URL is read by @voltline/db. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): GatewayConfig {
  return {
    port: nonNegativeInteger('PORT', env['PORT'], 9220),
    host: env['HOST'] ?? '0.0.0.0',
    heartbeatIntervalSec: nonNegativeInteger(
      'HEARTBEAT_INTERVAL_S',
      env['HEARTBEAT_INTERVAL_S'],
      300,
    ),
    logLevel: env['LOG_LEVEL'] ?? 'info',
    redisUrl: env['REDIS_URL'] ?? 'redis://localhost:6379',
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
