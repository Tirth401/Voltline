import type { Redis } from 'ioredis';

/** A StatusNotification, reduced to what we keep. */
export interface ConnectorStatus {
  chargePointId: string;
  /** 0 means the charger as a whole. */
  connectorId: number;
  status: string;
  errorCode: string;
  info?: string;
  vendorErrorCode?: string;
  /** When the status changed: the charger's timestamp, or when we received it if it sent none. */
  timestamp: Date;
}

// Replaces a connector's status only if the update is at least as new as the stored one. It runs
// atomically inside Redis, so two gateways can't interleave a read and a write (D-021).
const RECORD_IF_NEWER = `
local stored = tonumber(redis.call('HGET', KEYS[1], 'timestampMs'))
if stored and stored > tonumber(ARGV[1]) then return 0 end
redis.call('DEL', KEYS[1])
redis.call('HSET', KEYS[1], 'timestampMs', ARGV[1], unpack(ARGV, 3))
redis.call('SADD', KEYS[2], ARGV[2])
return 1
`;

/** Live connector status, one Redis hash per connector. */
export class AvailabilityStore {
  readonly #redis: Redis;
  readonly #prefix: string;

  constructor(redis: Redis, keyPrefix = 'voltline:') {
    this.#redis = redis;
    this.#prefix = keyPrefix;
  }

  /** Stores a status. Returns false if it was older than the one already stored, and was dropped. */
  async record(update: ConnectorStatus): Promise<boolean> {
    const fields = ['status', update.status, 'errorCode', update.errorCode];
    if (update.info !== undefined) fields.push('info', update.info);
    if (update.vendorErrorCode !== undefined)
      fields.push('vendorErrorCode', update.vendorErrorCode);
    const applied = await this.#redis.eval(
      RECORD_IF_NEWER,
      2,
      this.#statusKey(update.chargePointId, update.connectorId),
      this.#connectorsKey(update.chargePointId),
      String(update.timestamp.getTime()),
      String(update.connectorId),
      ...fields,
    );
    return applied === 1;
  }

  /** Every connector of a charger we've heard about, in connector order. */
  async connectors(chargePointId: string): Promise<ConnectorStatus[]> {
    const ids = (await this.#redis.smembers(this.#connectorsKey(chargePointId)))
      .map(Number)
      .sort((a, b) => a - b);
    const hashes = await Promise.all(
      ids.map((id) => this.#redis.hgetall(this.#statusKey(chargePointId, id))),
    );
    return ids.flatMap((connectorId, i) => {
      const hash = hashes[i];
      if (!hash?.['status'] || !hash['errorCode'] || !hash['timestampMs']) return [];
      const status: ConnectorStatus = {
        chargePointId,
        connectorId,
        status: hash['status'],
        errorCode: hash['errorCode'],
        timestamp: new Date(Number(hash['timestampMs'])),
      };
      if (hash['info'] !== undefined) status.info = hash['info'];
      if (hash['vendorErrorCode'] !== undefined) status.vendorErrorCode = hash['vendorErrorCode'];
      return [status];
    });
  }

  // The {braces} are a Redis Cluster hash tag: all of one charger's keys land on the same node.
  #statusKey(chargePointId: string, connectorId: number): string {
    return `${this.#prefix}status:{${chargePointId}}:${connectorId}`;
  }

  #connectorsKey(chargePointId: string): string {
    return `${this.#prefix}connectors:{${chargePointId}}`;
  }
}
