/** Anything that needs "now" takes a Clock, so tests and the simulator can control time. */
export interface Clock {
  now(): Date;
}

export const systemClock: Clock = {
  now: () => new Date(),
};

/** A clock that only moves when told to: for tests and the simulator's compressed time. */
export class ManualClock implements Clock {
  #ms: number;

  constructor(start: Date | number) {
    this.#ms = toMs(start);
  }

  now(): Date {
    return new Date(this.#ms);
  }

  /** Moves forward. Use set() to make the clock jump, including backwards. */
  advance(ms: number): void {
    if (!Number.isFinite(ms) || ms < 0) {
      throw new RangeError(`advance(ms) needs a finite ms >= 0, got ${ms}`);
    }
    this.#ms += ms;
  }

  /** Jumps to any time, e.g. a charger whose clock resets after a reboot. */
  set(time: Date | number): void {
    this.#ms = toMs(time);
  }
}

function toMs(time: Date | number): number {
  const ms = typeof time === 'number' ? time : time.getTime();
  if (!Number.isFinite(ms)) {
    throw new RangeError(`not a valid time: ${String(time)}`);
  }
  return ms;
}
