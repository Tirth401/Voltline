import type { Redis } from 'ioredis';

/**
 * Connection rebalancing (D-039). The gateway Service hands each new connection to a random ready
 * pod, so after one gateway restarts, the others keep its chargers and it stays almost empty: the
 * chargers have no reason to move. So every gateway reports how many chargers it holds, and one
 * that holds clearly more than its fair share closes a few connections each round. Their chargers
 * reconnect through the Service; while it is shedding, the busy gateway turns new chargers away,
 * so they land on the one with room.
 */
export interface RebalanceSettings {
  /** How far over the fair share a gateway may go before it sheds: max(slackMin, slackRatio × fair). */
  slackMin: number;
  slackRatio: number;
  /** The most connections one gateway closes per round, so moving chargers is never a storm. */
  maxShedPerRound: number;
  /**
   * Rounds in a row a gateway must be over before it starts shedding. While chargers are still
   * arriving (a cold start, say), the counts are uneven for a moment by chance; moving chargers
   * then only costs them a second boot.
   */
  patienceRounds: number;
}

export const DEFAULT_REBALANCE: RebalanceSettings = {
  slackMin: 50,
  slackRatio: 0.1,
  maxShedPerRound: 50,
  patienceRounds: 3,
};

/** What one round passes on to the next. */
export interface RebalanceState {
  /** Shedding: closing connections, and turning new chargers away, until back to the fair share. */
  shedding: boolean;
  /** The estimate of every gateway's chargers together. */
  total: number;
  /** Rounds in a row this gateway has been over its share without shedding yet. */
  roundsOver: number;
}

export interface RebalanceDecision extends RebalanceState {
  /** Chargers per gateway if they were spread evenly. */
  fairShare: number;
  /** Connections to close this round. */
  shed: number;
}

/**
 * One gateway's decision for one round, from everyone's current counts (its own included). It
 * starts shedding only when it has been over the fair share by more than the slack for a few
 * rounds in a row, so the ordinary unevenness of random placement never moves anyone, and then
 * keeps going until it is down to the fair share. It never sheds if no other gateway is below the
 * fair share: those chargers would have nowhere better to go.
 *
 * Chargers on their way from one gateway to another are in nobody's count for a moment, so the
 * total dips for as long as connections are moving, and a fair share worked out from it would be
 * too low: the busy gateway would shed a few too many. So while a gateway is shedding, its estimate
 * of the total never goes down; once it stops, the estimate is simply what everyone counts.
 */
export function planRebalance(input: {
  gatewayId: string;
  loads: ReadonlyMap<string, number>;
  settings: RebalanceSettings;
  /** The previous round's state; none for the first round. */
  previous?: RebalanceState;
}): RebalanceDecision {
  const { loads, settings } = input;
  const previous = input.previous ?? { shedding: false, total: 0, roundsOver: 0 };
  const own = loads.get(input.gatewayId) ?? 0;
  let counted = 0;
  for (const count of loads.values()) counted += count;
  const total = previous.shedding ? Math.max(counted, previous.total) : counted;
  const fairShare = loads.size === 0 ? 0 : total / loads.size;
  const target = Math.ceil(fairShare);
  const slack = Math.max(settings.slackMin, settings.slackRatio * fairShare);
  const roomElsewhere = [...loads].some(
    ([id, count]) => id !== input.gatewayId && count < fairShare,
  );
  const over = roomElsewhere && own > fairShare + slack;
  const roundsOver = over && !previous.shedding ? previous.roundsOver + 1 : 0;
  const shedding =
    roomElsewhere &&
    own > target &&
    (previous.shedding || roundsOver >= Math.max(1, settings.patienceRounds));
  return {
    shedding,
    total: shedding ? total : counted,
    roundsOver: shedding ? 0 : roundsOver,
    fairShare,
    shed: shedding ? Math.min(settings.maxShedPerRound, own - target) : 0,
  };
}

// Atomically: record this gateway's count and the time, forget gateways that stopped reporting,
// and return everyone's counts. An empty count removes this gateway (it is shutting down).
const REPORT = `
local time = redis.call('TIME')
local now = tonumber(time[1]) * 1000 + math.floor(tonumber(time[2]) / 1000)
if ARGV[2] == '' then
  redis.call('HDEL', KEYS[1], ARGV[1])
  redis.call('ZREM', KEYS[2], ARGV[1])
  return {}
end
redis.call('HSET', KEYS[1], ARGV[1], ARGV[2])
redis.call('ZADD', KEYS[2], now, ARGV[1])
local gone = redis.call('ZRANGEBYSCORE', KEYS[2], '-inf', now - tonumber(ARGV[3]))
for _, id in ipairs(gone) do
  redis.call('HDEL', KEYS[1], id)
  redis.call('ZREM', KEYS[2], id)
end
return redis.call('HGETALL', KEYS[1])
`;

/** Every gateway's latest count of its chargers, in Redis. */
export class LoadBoard {
  readonly #redis: Redis;
  readonly #prefix: string;
  readonly #staleMs: number;

  /** A gateway that hasn't reported for `staleMs` is forgotten: it crashed or was removed. */
  constructor(redis: Redis, options: { keyPrefix?: string; staleMs: number }) {
    this.#redis = redis;
    this.#prefix = options.keyPrefix ?? 'voltline:';
    this.#staleMs = options.staleMs;
  }

  /** Records this gateway's count, and returns every live gateway's count, its own included. */
  async report(gatewayId: string, connections: number): Promise<Map<string, number>> {
    const flat = (await this.#call(gatewayId, String(connections))) as string[];
    const loads = new Map<string, number>();
    for (let i = 0; i + 1 < flat.length; i += 2) {
      loads.set(flat[i] as string, Number(flat[i + 1]));
    }
    return loads;
  }

  /** Takes this gateway off the board, so the others stop counting it. */
  async remove(gatewayId: string): Promise<void> {
    await this.#call(gatewayId, '');
  }

  #call(gatewayId: string, count: string): Promise<unknown> {
    return this.#redis.eval(
      REPORT,
      2,
      `${this.#prefix}gateway-load`,
      `${this.#prefix}gateway-seen`,
      gatewayId,
      count,
      this.#staleMs,
    );
  }
}
