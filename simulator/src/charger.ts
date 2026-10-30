import { setTimeout as sleep } from 'node:timers/promises';
import { ManualClock, Prng } from '@voltline/common';
import {
  OcppCallError,
  type Payload,
  type V16ChargerAction,
  type V16Request,
  type V16Validator,
} from '@voltline/ocpp';
import {
  NO_FAULTS,
  planSession,
  shuffleQueue,
  type FaultProfile,
  type SessionPlan,
} from './faults.ts';
import { Meter } from './meter.ts';
import { ConnectionRefusedError, OcppClient } from './ocpp-client.ts';

export interface ChargerOptions {
  /**
   * e.g. ws://127.0.0.1:9220/ocpp; the charger appends its own identity. With several, each
   * connection picks one at random, as a load balancer in front of several gateways would.
   */
  gatewayUrl: string | readonly string[];
  chargePointId: string;
  idTag: string;
  /** This charger's own random stream: every choice it makes comes from here (D-011). */
  rng: Prng;
  faults?: FaultProfile;
  /** Where the charger's virtual clock starts. */
  startTime?: Date;
  /**
   * Real milliseconds each simulated minute of charging takes. 0 (the default) runs as fast as
   * possible; tests of remote commands slow it down so a session is still running when they act.
   */
  realMsPerMinute?: number;
  /** Check both directions of every message against the official schemas. */
  validator?: V16Validator;
}

/** What one simulated session really did: the truth billing has to match (D-010). */
export interface SessionTruth {
  chargePointId: string;
  connectorId: number;
  idTag: string;
  /** 0 for the charger's first session, 1 for its second… */
  index: number;
  plan: SessionPlan;
  transactionId: number;
  /** Every transactionId the gateway answered this session's StartTransaction copies with. */
  transactionIdsSeen: number[];
  startedAt: Date;
  stoppedAt: Date;
  meterStartWh: number;
  meterStopWh: number;
  physicalWh: number;
  evidencedWh: number;
  /** Distinct sampled values sent: MeterValues plus StopTransaction's transactionData. */
  samplesSent: number;
  /** The faults that actually happened in this session. */
  faults: {
    startedOffline: boolean;
    shuffled: boolean;
    /** MeterValues messages delivered after this session's StopTransaction had been answered. */
    readingsAfterStop: number;
    reset?: 'reported' | 'unreported';
    lostResponses: number;
    droppedAfterSend: number;
    /** Times the connection broke under the charger (a gateway crashed) and it reconnected. */
    reconnects: number;
    /** BootNotifications answered Pending before this session (only a charger's first session can have any). */
    pendingBoots: number;
  };
  /** The exact payloads sent, so tests can resend them. */
  startRequest: V16Request<'StartTransaction'>;
  meterValuesRequests: V16Request<'MeterValues'>[];
  stopRequest: V16Request<'StopTransaction'>;
}

type ConnectorStatus = V16Request<'StatusNotification'>['status'];
type SampledValue = V16Request<'MeterValues'>['meterValue'][number]['sampledValue'][number];
type ReadingContext = NonNullable<SampledValue['context']>;

/** A transaction message waiting in the charger's outbox. Built once, so a resend is identical. */
interface Queued {
  action: 'StartTransaction' | 'MeterValues' | 'StopTransaction';
  build: () => Payload;
  built?: Payload;
  /** Sees every answer, including ones the charger then "loses". */
  onAnswer?: (answer: Payload) => void;
}

const CONNECTOR_ID = 1;
const MINUTE_MS = 60_000;
const MAX_ATTEMPTS = 25;
// Reconnecting after gateway crashes: up to 2 s between tries, and about two minutes in all.
const MAX_TRANSPORT_FAILURES = 60;
const MAX_CONNECT_FAILURES = 60;
const BASE_BACKOFF_MS = 50;
const MAX_BACKOFF_MS = 2_000;
const DEFAULT_START = new Date('2026-01-01T08:00:00Z');

/**
 * A charger that runs charging sessions back to back on one connector, misbehaving as its fault
 * profile says (D-025). Like a real OCPP 1.6 charger, it queues StartTransaction, MeterValues and
 * StopTransaction in an outbox and keeps them until the gateway has answered, so nothing it sends
 * is ever lost, only delayed, repeated or reordered.
 *
 * Time is virtual: an hour of charging takes milliseconds, and billing can't tell, because it only
 * trusts the charger's timestamps (D-022).
 */
export class SimulatedCharger {
  readonly #options: ChargerOptions;
  readonly #rng: Prng;
  readonly #faults: FaultProfile;
  readonly #clock: ManualClock;
  readonly #meter: Meter;
  #client: OcppClient | undefined;
  #online = true;
  #outbox: Queued[] = [];
  #status: ConnectorStatus = 'Available';
  readonly #counts = { lostResponses: 0, droppedAfterSend: 0, reconnects: 0, pendingBoots: 0 };
  #sessionCount = 0;
  // Remote mode (D-030): commands from the CSMS start and stop sessions.
  #serving = false;
  #busy = false;
  #stopRequested = false;
  #currentTransactionId: number | undefined;
  readonly #remoteSessions: Promise<SessionTruth>[] = [];
  /**
   * Network choices (which gateway, how long to back off) come from a separate stream. They
   * depend on how often gateways crash, which a seed can't control; keeping them apart means the
   * charger's own behaviour stays exactly reproducible from the seed regardless (D-011).
   */
  readonly #net: Prng;
  readonly #gatewayUrls: readonly string[];

  constructor(options: ChargerOptions) {
    this.#options = options;
    this.#net = options.rng.fork('network');
    this.#gatewayUrls =
      typeof options.gatewayUrl === 'string' ? [options.gatewayUrl] : options.gatewayUrl;
    this.#rng = options.rng;
    this.#faults = options.faults ?? NO_FAULTS;
    this.#clock = new ManualClock(options.startTime ?? DEFAULT_START);
    this.#meter = new Meter(this.#rng.int(0, 5_000_000));
  }

  /** Boots, runs `sessions` sessions one after another, and hangs up. */
  async run(sessions: number): Promise<SessionTruth[]> {
    const truths: SessionTruth[] = [];
    try {
      await this.#boot();
      for (let i = 0; i < sessions; i++) {
        const start = { idTag: this.#options.idTag, remote: false };
        truths.push(await this.#runSession(this.#sessionCount++, start));
        this.#clock.advance(this.#rng.int(1, 30) * MINUTE_MS); // idle until the next car
      }
    } finally {
      await this.#client?.close();
    }
    return truths;
  }

  /**
   * Remote mode: boots, then waits for commands from the CSMS instead of running scripted
   * sessions. RemoteStartTransaction starts a session and RemoteStopTransaction ends it (D-030).
   * Call finish() when done.
   */
  async serve(): Promise<void> {
    await this.#boot();
    this.#serving = true;
  }

  /** Waits for every remotely started session to end, hangs up, and returns what they did. */
  async finish(): Promise<SessionTruth[]> {
    this.#serving = false;
    try {
      return await Promise.all(this.#remoteSessions);
    } finally {
      await this.#client?.close();
      this.#client = undefined;
    }
  }

  async #boot(): Promise<void> {
    const request = {
      chargePointVendor: 'Voltline',
      chargePointModel: 'SimCharger',
      firmwareVersion: '0.1.0',
    };
    let boot = (await this.#send('BootNotification', request)) as {
      status: string;
      interval: number;
    };
    // Pending: OCPP 1.6 says to boot again after `interval` seconds and to send nothing else
    // meanwhile. How often that happens depends on timing, so these retries draw nothing from the
    // seeded stream (D-028): the charger's own behaviour stays exactly as the seed says.
    while (boot.status === 'Pending') {
      this.#counts.pendingBoots += 1;
      await sleep(Math.max(1, boot.interval) * 1_000);
      boot = (await this.#deliver('BootNotification', request, 'wait for the answer')) as {
        status: string;
        interval: number;
      };
    }
    if (boot.status !== 'Accepted') throw new Error(`BootNotification was ${boot.status}`);
    await this.#send('Heartbeat', {});
    await this.#reportStatus(0, 'Available');
    await this.#reportStatus(CONNECTOR_ID, 'Available');
  }

  /** Answers a command from the CSMS. It runs alongside whatever the charger is doing. */
  #answerCommand(action: string, payload: Payload): Promise<Payload> {
    switch (action) {
      case 'TriggerMessage': {
        const requested = payload['requestedMessage'];
        if (requested !== 'Heartbeat' && requested !== 'StatusNotification') {
          return Promise.resolve({ status: 'NotImplemented' });
        }
        // Answer first; the triggered message follows once the answer is out.
        setImmediate(() => {
          void this.#sendTriggered(requested);
        });
        return Promise.resolve({ status: 'Accepted' });
      }
      case 'RemoteStartTransaction': {
        if (!this.#serving || this.#busy) return Promise.resolve({ status: 'Rejected' });
        const idTag = String(payload['idTag']);
        this.#busy = true; // claim the connector now, so a second start is turned down
        this.#remoteSessions.push(
          sleep(0).then(() => this.#runSession(this.#sessionCount++, { idTag, remote: true })),
        );
        return Promise.resolve({ status: 'Accepted' });
      }
      case 'RemoteStopTransaction': {
        if (!this.#busy || payload['transactionId'] !== this.#currentTransactionId) {
          return Promise.resolve({ status: 'Rejected' });
        }
        this.#stopRequested = true;
        return Promise.resolve({ status: 'Accepted' });
      }
      default:
        return Promise.reject(new OcppCallError('NotImplemented', `${action} is not simulated`));
    }
  }

  /** Sends a message the CSMS asked for. Best effort, and outside the seeded script. */
  async #sendTriggered(requested: 'Heartbeat' | 'StatusNotification'): Promise<void> {
    const client = this.#client;
    if (!client) return;
    const payload =
      requested === 'Heartbeat'
        ? {}
        : {
            connectorId: CONNECTOR_ID,
            errorCode: 'NoError',
            status: this.#status,
            timestamp: this.#clock.now().toISOString(),
          };
    await client.callPayload(requested, payload).catch(() => undefined);
  }

  async #runSession(
    index: number,
    start: { idTag: string; remote: boolean },
  ): Promise<SessionTruth> {
    const { chargePointId } = this.#options;
    const { idTag } = start;
    this.#busy = true;
    this.#stopRequested = false;
    this.#currentTransactionId = undefined;
    const realMsPerMinute = this.#options.realMsPerMinute ?? 0;
    const plan = planSession(this.#rng, this.#faults);
    const countsBefore = { ...this.#counts };
    let transactionId: number | undefined;
    const transactionIdsSeen: number[] = [];
    const meterValuesRequests: V16Request<'MeterValues'>[] = [];
    let stopRequest: V16Request<'StopTransaction'> | undefined;
    let samplesSent = 0;
    let reset: SessionTruth['faults']['reset'];
    let stopAnswered = false;
    let readingsAfterStop = 0;

    const knownTransactionId = (): number => {
      if (transactionId === undefined)
        throw new Error('bug: sent before StartTransaction answered');
      return transactionId;
    };
    const queueReadings = (readings: { wh: number; context: ReadingContext; at: Date }[]): void => {
      const meterValue = readings.map(({ wh, context, at }) => ({
        timestamp: at.toISOString(),
        sampledValue: [register(wh, context)],
      }));
      samplesSent += readings.length;
      this.#outbox.push({
        action: 'MeterValues',
        build: () => {
          const request = {
            connectorId: CONNECTOR_ID,
            transactionId: knownTransactionId(),
            meterValue,
          };
          meterValuesRequests.push(request);
          if (stopAnswered) readingsAfterStop += 1;
          return request;
        },
      });
    };

    // Step 0: the car plugs in and the session starts.
    await this.#beforeStep(plan, 0);
    // A remote start skips Authorize: the CSMS already chose the tag (AuthorizeRemoteTxRequests off).
    if (this.#online && !start.remote) {
      await this.#reportStatus(CONNECTOR_ID, 'Preparing');
      const { idTagInfo } = (await this.#send('Authorize', { idTag })) as {
        idTagInfo: { status: string };
      };
      if (idTagInfo.status !== 'Accepted') throw new Error(`${idTag} was ${idTagInfo.status}`);
    } // Offline, OCPP 1.6 lets a charger authorize from its local list and charge anyway.
    this.#clock.advance(10_000);
    const startedAt = this.#clock.now();
    const startRequest = {
      connectorId: CONNECTOR_ID,
      idTag,
      meterStart: this.#meter.beginSession(),
      timestamp: startedAt.toISOString(),
    };
    this.#outbox.push({
      action: 'StartTransaction',
      build: () => startRequest,
      onAnswer: (answer) => {
        const id = (answer as { transactionId: number }).transactionId;
        transactionIdsSeen.push(id);
        transactionId ??= id;
        this.#currentTransactionId ??= id;
      },
    });
    this.#status = 'Charging';
    await this.#afterStep(plan, 0);

    // Steps 1…minutes: charge, with a meter reading every minute.
    for (let minute = 1; minute <= plan.minutes; minute++) {
      if (this.#stopRequested) break; // RemoteStopTransaction: end the session now
      await this.#beforeStep(plan, minute);
      this.#clock.advance(MINUTE_MS);
      this.#chargeFor(plan, MINUTE_MS);
      queueReadings([
        { wh: this.#meter.emit(), context: 'Sample.Periodic', at: this.#clock.now() },
      ]);
      if (plan.reset?.afterMinute === minute) {
        this.#clock.advance(30_000);
        this.#chargeFor(plan, 30_000);
        if (plan.reset.reported) {
          // A well-behaved charger reports the register just before and just after (D-009).
          const before = { wh: this.#meter.emit(), at: this.#clock.now() };
          this.#meter.reset();
          this.#clock.advance(1_000);
          queueReadings([
            { ...before, context: 'Interruption.Begin' },
            { wh: this.#meter.emit(), context: 'Interruption.End', at: this.#clock.now() },
          ]);
          reset = 'reported';
        } else {
          this.#meter.reset();
          reset = 'unreported';
        }
      }
      await this.#afterStep(plan, minute);
      if (realMsPerMinute > 0) await sleep(realMsPerMinute);
    }

    // A remote stop ends the session early: drop the rest of any offline spell, catch up first.
    const remaining = this.#stopRequested ? { ...plan, offline: undefined } : plan;
    if (this.#stopRequested && !this.#online) await this.#reconnect(plan.shuffleOnReconnect);
    const reason = this.#stopRequested ? ('Remote' as const) : ('EVDisconnected' as const);

    // Step minutes + 1: the car leaves and the session stops.
    const stopStep = plan.minutes + 1;
    await this.#beforeStep(remaining, stopStep);
    this.#clock.advance(MINUTE_MS);
    this.#chargeFor(plan, MINUTE_MS);
    const meterStop = this.#meter.emit();
    const stoppedAt = this.#clock.now();
    samplesSent += 1;
    this.#outbox.push({
      action: 'StopTransaction',
      build: () => {
        const request = {
          transactionId: knownTransactionId(),
          idTag,
          meterStop,
          timestamp: stoppedAt.toISOString(),
          reason,
          transactionData: [
            {
              timestamp: stoppedAt.toISOString(),
              sampledValue: [register(meterStop, 'Transaction.End')],
            },
          ],
        };
        stopRequest = request;
        return request;
      },
      onAnswer: () => {
        stopAnswered = true;
      },
    });
    this.#status = 'Available';
    await this.#afterStep(remaining, stopStep);

    // Step minutes + 2: if the charger was still offline, it reconnects now and catches up.
    await this.#beforeStep(remaining, stopStep + 1);
    await this.#afterStep(remaining, stopStep + 1);

    if (this.#outbox.length > 0 || transactionId === undefined || stopRequest === undefined) {
      throw new Error(`bug: session ${index} of ${chargePointId} ended with messages undelivered`);
    }
    this.#busy = false;
    this.#currentTransactionId = undefined;
    return {
      chargePointId,
      connectorId: CONNECTOR_ID,
      idTag,
      index,
      plan,
      transactionId,
      transactionIdsSeen,
      startedAt,
      stoppedAt,
      meterStartWh: startRequest.meterStart,
      meterStopWh: meterStop,
      physicalWh: this.#meter.physicalWh,
      evidencedWh: this.#meter.evidencedWh,
      samplesSent,
      faults: {
        startedOffline: plan.offline?.from === 0,
        readingsAfterStop,
        shuffled: plan.offline !== undefined && plan.shuffleOnReconnect,
        ...(reset && { reset }),
        lostResponses: this.#counts.lostResponses - countsBefore.lostResponses,
        droppedAfterSend: this.#counts.droppedAfterSend - countsBefore.droppedAfterSend,
        reconnects: this.#counts.reconnects - countsBefore.reconnects,
        pendingBoots: index === 0 ? this.#counts.pendingBoots : 0,
      },
      startRequest,
      meterValuesRequests,
      stopRequest,
    };
  }

  /** Drops offline or comes back online, if the plan says this step begins or ends a spell. */
  async #beforeStep(plan: SessionPlan, step: number): Promise<void> {
    if (plan.offline?.from === step) await this.#goOffline();
    if (plan.offline?.to === step) await this.#reconnect(plan.shuffleOnReconnect);
  }

  /** Sends whatever this step queued, if the charger is online. */
  async #afterStep(plan: SessionPlan, step: number): Promise<void> {
    if (!this.#online) return;
    await this.#flush();
    if (step === 0) await this.#reportStatus(CONNECTOR_ID, 'Charging');
    if (step === plan.minutes + 1) {
      await this.#reportStatus(CONNECTOR_ID, 'Finishing');
      await this.#reportStatus(CONNECTOR_ID, 'Available');
    }
  }

  async #goOffline(): Promise<void> {
    this.#online = false;
    const client = this.#client;
    this.#client = undefined;
    await client?.close();
  }

  /** Back online: send everything queued, shuffled if the plan says so, then the current status. */
  async #reconnect(shuffle: boolean): Promise<void> {
    this.#online = true;
    if (shuffle) this.#outbox = shuffleQueue(this.#rng, this.#outbox);
    await this.#flush();
    await this.#reportStatus(CONNECTOR_ID, this.#status);
  }

  async #flush(): Promise<void> {
    while (this.#outbox.length > 0) {
      const message = this.#outbox[0] as Queued;
      message.built ??= message.build();
      await this.#send(message.action, message.built, message.onAnswer);
      this.#outbox.shift();
    }
  }

  async #reportStatus(connectorId: number, status: ConnectorStatus): Promise<void> {
    await this.#send('StatusNotification', {
      connectorId,
      errorCode: 'NoError',
      status,
      timestamp: this.#clock.now().toISOString(),
    });
  }

  /**
   * Sends one message until the charger has an answer, applying the fault profile on the way:
   * a lost answer means sending the same message again; a dropped connection means reconnecting
   * and sending it again.
   */
  async #send(
    action: V16ChargerAction,
    payload: Payload,
    onAnswer?: (answer: Payload) => void,
  ): Promise<Payload> {
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      if (this.#rng.chance(this.#faults.dropAfterSend)) {
        this.#counts.droppedAfterSend += 1;
        await this.#deliver(action, payload, 'hang up after sending');
        continue;
      }
      const answer = await this.#deliver(action, payload, 'wait for the answer');
      onAnswer?.(answer);
      if (this.#rng.chance(this.#faults.lostResponse)) {
        this.#counts.lostResponses += 1;
        continue; // the answer never reached the charger, so it sends the same message again
      }
      return answer;
    }
    throw new Error(`${action} still unanswered after ${MAX_ATTEMPTS} attempts`);
  }

  /**
   * One delivery attempt, carried out however many reconnects it takes. If the gateway dies
   * under the charger (crash, restart), nothing is lost: it reconnects, possibly to another
   * gateway, and sends the same message again. No fault draws happen here, so crashes can't
   * shift the charger's seeded behaviour.
   */
  async #deliver(
    action: V16ChargerAction,
    payload: Payload,
    mode: 'wait for the answer' | 'hang up after sending',
  ): Promise<Payload> {
    for (let failures = 0; ; failures++) {
      const client = await this.#connected();
      try {
        if (mode === 'hang up after sending') {
          this.#client = undefined;
          await client.sendThenClose(action, payload);
          return {};
        }
        return await client.callPayload(action, payload);
      } catch (error) {
        // The gateway answered with an OCPP error: that's a bug to surface, not a network fault.
        if (error instanceof OcppCallError) throw error;
        this.#client = undefined;
        this.#counts.reconnects += 1;
        if (failures >= MAX_TRANSPORT_FAILURES) {
          throw new Error(`${action} failed on ${failures + 1} connections in a row`, {
            cause: error,
          });
        }
      }
    }
  }

  /** The current connection, or a new one, retried with backoff while no gateway accepts. */
  async #connected(): Promise<OcppClient> {
    if (!this.#online) throw new Error('bug: tried to send while offline');
    for (let failures = 0; this.#client === undefined; failures++) {
      const url =
        this.#gatewayUrls.length === 1
          ? (this.#gatewayUrls[0] as string)
          : this.#net.pick(this.#gatewayUrls);
      try {
        this.#client = await OcppClient.connect(
          `${url}/${encodeURIComponent(this.#options.chargePointId)}`,
          {
            ...(this.#options.validator && { validator: this.#options.validator }),
            onCall: (action, payload) => this.#answerCommand(action, payload),
          },
        );
      } catch (error) {
        // An HTTP refusal (unknown charger, wrong subprotocol) won't fix itself by retrying. A 503
        // will: that gateway is shutting down (D-037) or holds more than its share (D-039), and
        // the next try may well reach another one.
        if (error instanceof ConnectionRefusedError && error.statusCode !== 503) throw error;
        if (failures >= MAX_CONNECT_FAILURES) {
          throw new Error(`no gateway accepted a connection in ${failures + 1} tries`, {
            cause: error,
          });
        }
        await sleep(this.#backoffMs(failures));
      }
    }
    return this.#client;
  }

  /**
   * Exponential backoff with full jitter: wait a random time between 0 and min(cap, base × 2^n).
   * The randomness spreads reconnects out, so chargers whose gateway died don't all knock on the
   * next one at the same instant.
   */
  #backoffMs(failures: number): number {
    return this.#net.int(0, Math.min(MAX_BACKOFF_MS, BASE_BACKOFF_MS * 2 ** failures));
  }

  /** Energy flows for `ms`: the car draws 90 to 100% of the session's power each time. */
  #chargeFor(plan: SessionPlan, ms: number): void {
    const percent = this.#rng.int(90, 100);
    this.#meter.deliver(Math.floor((plan.powerW * (ms / 1000) * percent) / 360_000));
  }
}

export interface SessionOptions {
  gatewayUrl: string;
  chargePointId: string;
  idTag: string;
  seed: number;
  startTime?: Date;
  validator?: V16Validator;
}

/** One well-behaved charger, one complete session: Milestone 1's scenario. */
export async function runSession(options: SessionOptions): Promise<SessionTruth> {
  const charger = new SimulatedCharger({
    ...options,
    rng: new Prng(options.seed).fork(options.chargePointId),
    faults: NO_FAULTS,
  });
  const [truth] = await charger.run(1);
  if (!truth) throw new Error('the session produced no result');
  return truth;
}

/** One energy-register sample, with every field spelled out rather than left to OCPP's defaults. */
function register(wh: number, context: ReadingContext): SampledValue {
  return {
    value: String(wh),
    context,
    measurand: 'Energy.Active.Import.Register',
    location: 'Outlet',
    unit: 'Wh',
  };
}
