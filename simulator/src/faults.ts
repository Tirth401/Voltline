import type { Prng } from '@voltline/common';

/**
 * How often each kind of misbehaviour happens (D-025). Every decision is drawn from the charger's
 * own seeded stream, so a seed always produces the same faults; only network timing varies.
 */
export interface FaultProfile {
  /** Chance a session includes a spell offline. Messages queue meanwhile; a start made offline is sent late. */
  offline: number;
  /** Chance, per message, that the answer is lost on its way back, so the charger sends it again. */
  lostResponse: number;
  /** Chance, per message, that the connection drops right after sending, before any answer. */
  dropAfterSend: number;
  /** Chance that a queue sent after an offline spell goes out shuffled. */
  reorder: number;
  /** Chance a session's meter resets once. Half the resets are reported, half aren't. */
  meterReset: number;
}

export const NO_FAULTS: FaultProfile = {
  offline: 0,
  lostResponse: 0,
  dropAfterSend: 0,
  reorder: 0,
  meterReset: 0,
};

/** The mix the billing runs use unless told otherwise. */
export const DEFAULT_FAULTS: FaultProfile = {
  offline: 0.3,
  lostResponse: 0.05,
  dropAfterSend: 0.02,
  reorder: 0.5,
  meterReset: 0.2,
};

// Common AC charging powers: 16 A single phase, 32 A single phase, 16 A and 32 A three phase.
const POWER_LEVELS_W = [3_700, 7_400, 11_000, 22_000];

/**
 * One session, planned up front from the seed. Its steps run from 0 (the start) through
 * 1…minutes (a meter reading each minute) to minutes + 1 (the stop); minutes + 2 is just after.
 */
export interface SessionPlan {
  powerW: number;
  minutes: number;
  /** Offline from the beginning of step `from` until the beginning of step `to`. */
  offline?: { from: number; to: number };
  /** Whether the queue built up while offline is sent shuffled on reconnecting. */
  shuffleOnReconnect: boolean;
  /** The meter resets once, half a minute after this minute's reading. */
  reset?: { afterMinute: number; reported: boolean };
}

export function planSession(rng: Prng, faults: FaultProfile): SessionPlan {
  const minutes = rng.int(5, 30);
  const plan: SessionPlan = {
    powerW: rng.pick(POWER_LEVELS_W),
    minutes,
    shuffleOnReconnect: false,
  };
  if (rng.chance(faults.offline)) {
    // A third of spells begin before the car arrives: the start itself is then queued and sent
    // late, the case where the server has to assign a transactionId after the fact (D-006).
    const from = rng.chance(1 / 3) ? 0 : rng.int(1, minutes + 1);
    plan.offline = { from, to: rng.int(from + 1, minutes + 2) };
    plan.shuffleOnReconnect = rng.chance(faults.reorder);
  }
  if (rng.chance(faults.meterReset)) {
    plan.reset = { afterMinute: rng.int(1, minutes), reported: rng.chance(0.5) };
  }
  return plan;
}

/**
 * Shuffles messages queued while offline, the way careless firmware might send them. The
 * session's StartTransaction stays first: everything else needs the transactionId its answer
 * carries, so not even a buggy charger can send them earlier.
 */
export function shuffleQueue<T extends { action: string }>(rng: Prng, queue: readonly T[]): T[] {
  const starts = queue.filter((message) => message.action === 'StartTransaction');
  const rest = queue.filter((message) => message.action !== 'StartTransaction');
  return [...starts, ...rng.shuffle(rest)];
}
