import type { Redis } from 'ioredis';

/** Where a charger's WebSocket currently lives. */
export interface ConnectionOwner {
  gatewayId: string;
  /** Unique per WebSocket connection. */
  connectionId: string;
  /** Counts the charger's connections: 1 for its first, 2 for the next… Higher is newer. */
  epoch: number;
}

// Atomically: count this connection, remember the previous owner, and take ownership.
const REGISTER = `
local epoch = redis.call('INCR', KEYS[2])
local previous = redis.call('GET', KEYS[1])
redis.call('SET', KEYS[1], cjson.encode({ gatewayId = ARGV[1], connectionId = ARGV[2], epoch = epoch }))
return { epoch, previous or false }
`;

// Atomically: forget the owner, but only if it is still this connection. A charger that has
// already reconnected elsewhere must not be forgotten by its old connection closing late.
const UNREGISTER = `
local current = redis.call('GET', KEYS[1])
if current and cjson.decode(current).connectionId == ARGV[1] then
  redis.call('DEL', KEYS[1])
  return 1
end
return 0
`;

/**
 * Which gateway holds each charger's socket, in Redis (D-030). Any process can look a charger up
 * and route a command to the right gateway.
 */
export class ConnectionRegistry {
  readonly #redis: Redis;
  readonly #prefix: string;

  constructor(redis: Redis, keyPrefix = 'voltline:') {
    this.#redis = redis;
    this.#prefix = keyPrefix;
  }

  /**
   * Records that this connection now holds the charger. Returns its epoch, and the previous owner
   * if there was one, so the caller can tell that gateway to close its stale socket.
   */
  async register(
    chargePointId: string,
    connection: { gatewayId: string; connectionId: string },
  ): Promise<{ epoch: number; previous: ConnectionOwner | undefined }> {
    const [epoch, previous] = (await this.#redis.eval(
      REGISTER,
      2,
      this.#ownerKey(chargePointId),
      this.#epochKey(chargePointId),
      connection.gatewayId,
      connection.connectionId,
    )) as [number, string | null];
    return { epoch, previous: previous === null ? undefined : parseOwner(previous) };
  }

  /** Forgets the charger's owner if it is still `connectionId`. Returns whether it did. */
  async unregister(chargePointId: string, connectionId: string): Promise<boolean> {
    const removed = await this.#redis.eval(
      UNREGISTER,
      1,
      this.#ownerKey(chargePointId),
      connectionId,
    );
    return removed === 1;
  }

  async owner(chargePointId: string): Promise<ConnectionOwner | undefined> {
    const raw = await this.#redis.get(this.#ownerKey(chargePointId));
    return raw === null ? undefined : parseOwner(raw);
  }

  // The {braces} are a Redis Cluster hash tag: both keys of one charger land on the same node.
  #ownerKey(chargePointId: string): string {
    return `${this.#prefix}owner:{${chargePointId}}`;
  }

  #epochKey(chargePointId: string): string {
    return `${this.#prefix}owner-epoch:{${chargePointId}}`;
  }
}

function parseOwner(raw: string): ConnectionOwner {
  return JSON.parse(raw) as ConnectionOwner;
}
