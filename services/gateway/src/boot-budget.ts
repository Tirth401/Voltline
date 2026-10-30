import type { Redis } from 'ioredis';

/** A charger may boot now, or must wait this long first. */
export type Admission = { accepted: true } | { accepted: false; waitMs: number };

export interface BootBudgetOptions {
  /** BootNotifications accepted per second, across every gateway together. */
  ratePerSecond: number;
  /** How many may be accepted at once after a quiet spell. */
  burst: number;
  keyPrefix?: string;
}

// A token bucket kept as one number, the "theoretical arrival time" (GCRA): when the bucket would
// be full again if nothing else came. Each boot moves it on by one interval. A boot is let in if
// that would leave the bucket within its burst; otherwise the boot is booked for the moment it
// would be, and the charger is told to come back then. Its appointment is kept under its own key,
// so when it comes back it is let in without paying a second time, and if it comes back early it
// keeps its place. The clock is Redis's own, so every gateway agrees on the time.
const ADMIT = `
local now
if ARGV[3] ~= '' then
  now = tonumber(ARGV[3])
else
  local time = redis.call('TIME')
  now = tonumber(time[1]) * 1000 + math.floor(tonumber(time[2]) / 1000)
end
local interval = tonumber(ARGV[1])
local tolerance = tonumber(ARGV[2])

local appointment = redis.call('GET', KEYS[2])
if appointment then
  appointment = tonumber(appointment)
  if now >= appointment then
    redis.call('DEL', KEYS[2])
    return {1, 0}
  end
  return {0, math.ceil(appointment - now)}
end

local tat = tonumber(redis.call('GET', KEYS[1]) or '0')
if tat < now then tat = now end
local allowAt = tat - tolerance
local nextTat = tat + interval
redis.call('SET', KEYS[1], nextTat, 'PX', math.ceil(nextTat - now + tolerance) + 1000)
if now >= allowAt then return {1, 0} end
redis.call('SET', KEYS[2], allowAt, 'PX', math.ceil(allowAt - now) + 60000)
return {0, math.ceil(allowAt - now)}
`;

/**
 * One budget for BootNotifications across the whole cluster, in Redis (D-038). After an outage,
 * thousands of chargers reconnect within seconds and every one boots; each boot is a database
 * write. Over budget, the gateway answers Pending with an `interval`, and OCPP 1.6 says the
 * charger must wait that long before booting again, on the same connection.
 *
 * The interval is the charger's own appointment, so the chargers turned away come back spread out
 * at the budget's rate, rather than all together one interval later.
 */
export class BootBudget {
  readonly #redis: Redis;
  readonly #intervalMs: number;
  readonly #toleranceMs: number;
  readonly #prefix: string;

  constructor(redis: Redis, options: BootBudgetOptions) {
    if (!(options.ratePerSecond > 0) || !(options.burst >= 1)) {
      throw new Error('a boot budget needs a rate above 0 and a burst of at least 1');
    }
    this.#redis = redis;
    this.#intervalMs = 1_000 / options.ratePerSecond;
    this.#toleranceMs = (options.burst - 1) * this.#intervalMs;
    this.#prefix = options.keyPrefix ?? 'voltline:';
  }

  /** `nowMs` is for tests; the gateways use Redis's clock. */
  async admit(chargePointId: string, nowMs?: number): Promise<Admission> {
    const [accepted, waitMs] = (await this.#redis.eval(
      ADMIT,
      2,
      `${this.#prefix}boot-budget`,
      `${this.#prefix}boot-appointment:{${chargePointId}}`,
      this.#intervalMs,
      this.#toleranceMs,
      nowMs ?? '',
    )) as [number, number];
    return accepted === 1 ? { accepted: true } : { accepted: false, waitMs };
  }
}

/** OCPP's `interval` is whole seconds: the smallest that is at least the wait, and never 0. */
export function retryIntervalSeconds(waitMs: number): number {
  return Math.max(1, Math.ceil(waitMs / 1_000));
}
