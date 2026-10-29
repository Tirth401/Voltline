/**
 * A charger's energy meter, plus the two ground truths billing is checked against (D-010).
 *
 * - physicalWh: every Wh that flowed this session.
 * - evidencedWh: what the readings the charger emitted can prove. It applies billing's rule,
 *   but in a separate implementation, folded over the clean log in the order the readings were
 *   emitted. Billing has to reach the same number from whatever survived the network.
 */
export class Meter {
  #registerWh: number;
  #lastEmittedWh: number;
  #physicalWh = 0;
  #evidencedWh = 0;

  constructor(initialRegisterWh: number) {
    assertWholeWh(initialRegisterWh);
    this.#registerWh = initialRegisterWh;
    this.#lastEmittedWh = initialRegisterWh;
  }

  get registerWh(): number {
    return this.#registerWh;
  }

  get physicalWh(): number {
    return this.#physicalWh;
  }

  get evidencedWh(): number {
    return this.#evidencedWh;
  }

  /** Starts a session at the current register, which the charger reports as meterStart. */
  beginSession(): number {
    this.#physicalWh = 0;
    this.#evidencedWh = 0;
    this.#lastEmittedWh = this.#registerWh;
    return this.#registerWh;
  }

  /** Energy flows: the register advances by exactly this many Wh. */
  deliver(wh: number): void {
    assertWholeWh(wh);
    this.#registerWh += wh;
    this.#physicalWh += wh;
  }

  /** The charger reports the register. Returns the value it reports. */
  emit(): number {
    const reported = this.#registerWh;
    const previous = this.#lastEmittedWh;
    this.#evidencedWh += reported >= previous ? reported - previous : reported;
    this.#lastEmittedWh = reported;
    return reported;
  }

  /**
   * The meter resets to zero (after a reboot, say). A well-behaved charger emits just before
   * and just after (Interruption.Begin, then Interruption.End); anything that flowed since the
   * last emitted reading is otherwise lost as evidence.
   */
  reset(): void {
    this.#registerWh = 0;
  }
}

function assertWholeWh(wh: number): void {
  if (!Number.isSafeInteger(wh) || wh < 0) {
    throw new RangeError(`energy must be a whole, non-negative number of Wh, got ${wh}`);
  }
}
