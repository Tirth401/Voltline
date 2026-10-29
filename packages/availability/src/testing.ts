import { Redis } from 'ioredis';

/** A Redis client for tests: fails fast instead of retrying forever when Redis isn't running. */
export function createTestRedis(): Redis {
  return new Redis(process.env['REDIS_URL'] ?? 'redis://localhost:6379', {
    maxRetriesPerRequest: 1,
    connectTimeout: 2_000,
  });
}

/** Deletes every key under a test's prefix, so test runs don't see each other's data. */
export async function deleteKeysWithPrefix(redis: Redis, prefix: string): Promise<void> {
  let cursor = '0';
  do {
    const [next, keys] = await redis.scan(cursor, 'MATCH', `${prefix}*`, 'COUNT', 500);
    if (keys.length > 0) await redis.del(...keys);
    cursor = next;
  } while (cursor !== '0');
}
