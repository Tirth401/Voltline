import { setTimeout as sleep } from 'node:timers/promises';
import type { Prng } from '@voltline/common';
import { OcppCallError, type Payload, type V16Validator } from '@voltline/ocpp';
import { OcppClient } from './ocpp-client.ts';

interface Change {
  at: number;
  key: string;
  watts: number;
}

/**
 * The ground truth for smart charging: every change in the power each connector is allowed to
 * draw, as the chargers themselves apply it, with real timestamps (D-032). The controller's
 * beliefs don't enter into it. It also notes what each connector could use, to measure how much
 * of the spare power the chargers were really given (D-016).
 */
export class LimitRecorder {
  readonly #now: () => number;
  readonly #limits: Change[] = [];
  readonly #demands: Change[] = [];
  readonly #current = new Map<string, number>();

  /** `now` gives the time in ms; tests pass their own clock. */
  constructor(now: () => number = () => performance.now()) {
    this.#now = now;
  }

  record(key: string, limitW: number): void {
    if (this.#current.get(key) === limitW) return;
    this.#current.set(key, limitW);
    this.#limits.push({ at: this.#now(), key, watts: limitW });
  }

  /** What a connector could use from now on: its maximum while a car charges, else its default. */
  recordDemand(key: string, wantW: number): void {
    this.#demands.push({ at: this.#now(), key, watts: wantW });
  }

  /**
   * The highest total the site was allowed to draw at any moment. Each connector counts at the
   * limit it applies: an active one at its profile's limit, an idle one at its default, because
   * a car could plug in and draw that at any moment.
   */
  peakTotalW(): number {
    const now = new Map<string, number>();
    let total = 0;
    let peak = 0;
    for (const change of [...this.#limits].sort((a, b) => a.at - b.at)) {
      total += change.watts - (now.get(change.key) ?? 0);
      now.set(change.key, change.watts);
      peak = Math.max(peak, total);
    }
    return peak;
  }

  /**
   * How much of the site's spare power the chargers were allowed to use between `from` and `to`
   * (D-016). Spare power is what the cap leaves once every connector has its default. At each
   * moment the most that could be handed out is all of it, or all that the charging cars could
   * use if that's less. The result is the time-weighted share of that the chargers really
   * applied: 1 if every car always had its fair share at once, 0 if nobody ever got more than the
   * default.
   */
  usefulness(capW: number, defaultW: number, from: number, to: number): number {
    const changes = [
      ...this.#limits.map((change) => ({ ...change, demand: false })),
      ...this.#demands.map((change) => ({ ...change, demand: true })),
    ].sort((a, b) => a.at - b.at);
    const limits = new Map<string, number>();
    const demands = new Map<string, number>();
    let given = 0;
    let possible = 0;
    let t = from;
    const until = (at: number): void => {
      const end = Math.min(at, to);
      if (end <= t) return;
      let allowedW = 0;
      let wantedW = 0;
      for (const [key, limitW] of limits) {
        allowedW += limitW;
        wantedW += demands.get(key) ?? defaultW;
      }
      const floorW = limits.size * defaultW;
      given += (allowedW - floorW) * (end - t);
      possible += Math.max(0, Math.min(capW, wantedW) - floorW) * (end - t);
      t = end;
    };
    for (const change of changes) {
      until(change.at);
      (change.demand ? demands : limits).set(change.key, change.watts);
    }
    until(to);
    return possible === 0 ? 1 : given / possible;
  }

  current(key: string): number | undefined {
    return this.#current.get(key);
  }

  get changes(): number {
    return this.#limits.length;
  }
}

export interface PowerFaults {
  /** Chance a charger refuses a SetChargingProfile. */
  rejectProfile: number;
  /** Chance its answer is lost on the way back, whatever it did with the profile. */
  loseAnswer: number;
  /** A charger takes this long, in real ms, to apply a profile and answer: [min, max]. */
  answerDelayMs: [number, number];
}

interface TxProfile {
  transactionId?: number;
  chargingProfilePurpose: string;
  validTo?: string;
  chargingSchedule: { chargingSchedulePeriod: { limit: number }[] };
}

export interface PowerChargerOptions {
  gatewayUrl: string;
  chargePointId: string;
  idTag: string;
  /** What it may draw with no profile: its TxDefaultProfile. */
  defaultW: number;
  /** The most it can deliver: what a charging car will take. */
  maxW: number;
  rng: Prng;
  faults: PowerFaults;
  recorder: LimitRecorder;
  validator?: V16Validator;
}

/**
 * A charger with one connector that obeys smart charging (D-032), following the parts of OCPP
 * 1.6's smart-charging rules the controller relies on:
 *
 * - Without a TxProfile it applies its default limit (its TxDefaultProfile).
 * - A TxProfile only applies to the transaction running when it arrives, and is dropped when
 *   that transaction ends.
 * - A TxProfile stops applying at its `validTo`, and the charger falls back to its default by
 *   itself. That lease is what keeps a charger safe when the CSMS can no longer reach it.
 * - A TxProfile that arrives after its `validTo` still replaces the old one, but never applies.
 *
 * It applies a new profile at the moment it answers, after a seeded delay. It may refuse it, and
 * its answer may be lost on the way back.
 */
export class PowerCharger {
  readonly key: string;
  readonly #options: PowerChargerOptions;
  #faults: PowerFaults;
  #client: OcppClient | undefined;
  #transactionId: number | undefined;
  #meterWh = 0;
  #profile: { limitW: number; timer: NodeJS.Timeout | undefined } | undefined;

  constructor(options: PowerChargerOptions) {
    this.#options = options;
    this.#faults = options.faults;
    this.key = `${options.chargePointId}/1`;
  }

  get charging(): boolean {
    return this.#transactionId !== undefined;
  }

  get online(): boolean {
    return this.#client !== undefined;
  }

  async connect(): Promise<void> {
    this.#client = await OcppClient.connect(
      `${this.#options.gatewayUrl}/${encodeURIComponent(this.#options.chargePointId)}`,
      {
        ...(this.#options.validator && { validator: this.#options.validator }),
        onCall: (action, payload) => this.#answer(action, payload),
      },
    );
    await this.#client.call('BootNotification', {
      chargePointVendor: 'Voltline',
      chargePointModel: 'PowerSim',
    });
    await this.#status(this.charging ? 'Charging' : 'Available');
    this.#apply();
  }

  /** Drops off the network. Its profile keeps applying until the lease runs out. */
  async disconnect(): Promise<void> {
    const client = this.#client;
    this.#client = undefined;
    await client?.close();
  }

  /** A car plugs in and starts charging, at the default limit until the CSMS says otherwise. */
  async startSession(): Promise<void> {
    const client = this.#requireClient();
    const { transactionId } = await client.call('StartTransaction', {
      connectorId: 1,
      idTag: this.#options.idTag,
      meterStart: this.#meterWh,
      timestamp: new Date().toISOString(),
    });
    this.#transactionId = transactionId;
    this.#options.recorder.recordDemand(this.key, this.#options.maxW);
    this.#apply();
    await this.#status('Charging');
  }

  /** The car leaves. The transaction's profile goes with it. */
  async stopSession(): Promise<void> {
    const client = this.#requireClient();
    const transactionId = this.#transactionId;
    if (transactionId === undefined) return;
    this.#transactionId = undefined;
    this.#clearProfile();
    this.#apply(); // the session is over: back to the default, before telling anyone
    this.#options.recorder.recordDemand(this.key, this.#options.defaultW);
    this.#meterWh += 1_000;
    await client.call('StopTransaction', {
      transactionId,
      meterStop: this.#meterWh,
      timestamp: new Date().toISOString(),
      reason: 'EVDisconnected',
    });
    await this.#status('Available');
  }

  async close(): Promise<void> {
    this.#clearProfile();
    await this.disconnect();
  }

  /** Changes how it misbehaves from now on. */
  setFaults(faults: PowerFaults): void {
    this.#faults = faults;
  }

  #answer(action: string, payload: Payload): Promise<Payload> {
    if (action === 'SetChargingProfile') return this.#setProfile(payload);
    if (action === 'ClearChargingProfile') {
      this.#clearProfile();
      this.#apply();
      return Promise.resolve({ status: 'Accepted' });
    }
    if (action === 'TriggerMessage') return Promise.resolve({ status: 'Accepted' });
    return Promise.reject(new OcppCallError('NotImplemented', `${action} is not simulated`));
  }

  async #setProfile(payload: Payload): Promise<Payload> {
    const profile = payload['csChargingProfiles'] as TxProfile;
    await sleep(this.#options.rng.int(...this.#faults.answerDelayMs));
    const status = this.#takeProfile(profile) ? 'Accepted' : 'Rejected';
    if (this.#options.rng.chance(this.#faults.loseAnswer)) {
      // Lost on the way back: the CSMS never learns what the charger did (D-032).
      return new Promise<never>(() => {
        /* no answer, ever */
      });
    }
    return { status };
  }

  /** Stores and applies a TxProfile, or refuses it. */
  #takeProfile(profile: TxProfile): boolean {
    const forThisTransaction =
      this.#transactionId !== undefined &&
      (profile.transactionId === undefined || profile.transactionId === this.#transactionId);
    if (
      profile.chargingProfilePurpose !== 'TxProfile' ||
      !forThisTransaction ||
      this.#options.rng.chance(this.#faults.rejectProfile)
    ) {
      return false;
    }
    const limitW =
      profile.chargingSchedule.chargingSchedulePeriod[0]?.limit ?? this.#options.defaultW;
    const leftMs =
      profile.validTo === undefined ? Infinity : Date.parse(profile.validTo) - Date.now();
    this.#clearProfile();
    if (leftMs > 0) {
      const timer = Number.isFinite(leftMs)
        ? setTimeout(() => {
            // The lease ran out: back to the default, with nobody's help (D-032).
            this.#profile = undefined;
            this.#apply();
          }, leftMs)
        : undefined;
      this.#profile = { limitW, timer };
    }
    this.#apply();
    return true;
  }

  #clearProfile(): void {
    clearTimeout(this.#profile?.timer);
    this.#profile = undefined;
  }

  /** Records the limit this connector now applies. */
  #apply(): void {
    const limitW =
      this.#transactionId !== undefined && this.#profile !== undefined
        ? this.#profile.limitW
        : this.#options.defaultW;
    this.#options.recorder.record(this.key, limitW);
  }

  async #status(status: 'Available' | 'Charging'): Promise<void> {
    await this.#requireClient().call('StatusNotification', {
      connectorId: 1,
      errorCode: 'NoError',
      status,
      timestamp: new Date().toISOString(),
    });
  }

  #requireClient(): OcppClient {
    if (!this.#client) throw new Error(`${this.#options.chargePointId} is offline`);
    return this.#client;
  }
}

export interface LoadChangeOptions {
  chargers: readonly PowerCharger[];
  /** How many cars arrive or leave in total. */
  changes: number;
  rng: Prng;
  /** Real time between load changes: [min, max] ms. */
  gapMs: [number, number];
  /** Chance that a load change also sends one charger offline for a while. */
  offlineChance: number;
  /** How long an offline spell lasts: [min, max] ms. */
  offlineMs: [number, number];
}

/**
 * Drives the load: one car at a time arrives at an idle charger or leaves a busy one, at seeded
 * moments, while some chargers drop off the network now and then. Returns what happened.
 */
export async function runLoadChanges(
  options: LoadChangeOptions,
): Promise<{ arrivals: number; departures: number; offlineSpells: number }> {
  const { chargers, rng } = options;
  const counts = { arrivals: 0, departures: 0, offlineSpells: 0 };
  const spells: Promise<void>[] = [];
  while (counts.arrivals + counts.departures < options.changes) {
    await sleep(rng.int(...options.gapMs));
    const online = chargers.filter((charger) => charger.online);
    if (online.length === 0) continue; // everyone is offline: wait for someone to come back
    const charger = rng.pick(online);
    if (charger.charging) {
      await charger.stopSession();
      counts.departures += 1;
    } else {
      await charger.startSession();
      counts.arrivals += 1;
    }
    if (rng.chance(options.offlineChance)) {
      const victim = rng.pick(chargers);
      if (victim.online && victim !== charger) {
        counts.offlineSpells += 1;
        const downMs = rng.int(...options.offlineMs);
        spells.push(
          (async () => {
            await victim.disconnect();
            await sleep(downMs);
            await victim.connect();
          })(),
        );
      }
    }
  }
  await Promise.all(spells);
  return counts;
}
