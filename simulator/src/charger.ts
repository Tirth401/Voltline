import { ManualClock, Prng } from '@voltline/common';
import type { V16Request, V16Validator } from '@voltline/ocpp';
import { Meter } from './meter.ts';
import { OcppClient } from './ocpp-client.ts';

export interface SessionOptions {
  /** e.g. ws://127.0.0.1:9220/ocpp. The charger appends its own identity. */
  gatewayUrl: string;
  chargePointId: string;
  idTag: string;
  seed: number;
  /** Where the charger's virtual clock starts. */
  startTime?: Date;
  /** Check both directions of every message against the official schemas. */
  validator?: V16Validator;
}

/** Everything the charger knows about the session it ran: what billing must match. */
export interface SessionGroundTruth {
  chargePointId: string;
  connectorId: number;
  idTag: string;
  seed: number;
  transactionId: number;
  startedAt: Date;
  stoppedAt: Date;
  meterStartWh: number;
  meterStopWh: number;
  physicalWh: number;
  evidencedWh: number;
  /** Sampled values sent, counting MeterValues and StopTransaction's transactionData. */
  samplesSent: number;
  /** The exact payloads sent, so tests can resend them. */
  startRequest: V16Request<'StartTransaction'>;
  meterValuesRequests: V16Request<'MeterValues'>[];
  stopRequest: V16Request<'StopTransaction'>;
}

type ConnectorStatus = V16Request<'StatusNotification'>['status'];
type SampledValue = V16Request<'MeterValues'>['meterValue'][number]['sampledValue'][number];

const CONNECTOR_ID = 1;
// Common AC charging powers: 16 A single phase, 32 A single phase, 16 A and 32 A three phase.
const POWER_LEVELS_W = [3_700, 7_400, 11_000, 22_000];
const SAMPLE_INTERVAL_MS = 60_000;

/**
 * One well-behaved charger running one complete session: boot, report available, authorize,
 * start, charge with a meter reading every minute, stop, report available again.
 *
 * Every random choice comes from the seed (D-011), and time is virtual, so an hour of charging
 * takes milliseconds. Billing only trusts the charger's timestamps, so it can't tell.
 */
export async function runSession(options: SessionOptions): Promise<SessionGroundTruth> {
  const rng = new Prng(options.seed).fork(options.chargePointId);
  const clock = new ManualClock(options.startTime ?? new Date('2026-01-01T08:00:00Z'));
  const meter = new Meter(rng.int(0, 5_000_000));
  const powerW = rng.pick(POWER_LEVELS_W);
  const minutes = rng.int(5, 30);
  const now = (): string => clock.now().toISOString();
  const chargeOneInterval = (): void => {
    clock.advance(SAMPLE_INTERVAL_MS);
    // Real cars don't draw perfectly flat power: take 90 to 100% of it each minute.
    const percent = rng.int(90, 100);
    meter.deliver(Math.floor((powerW * (SAMPLE_INTERVAL_MS / 1000) * percent) / 360_000));
  };

  const client = await OcppClient.connect(
    `${options.gatewayUrl}/${encodeURIComponent(options.chargePointId)}`,
    options.validator ? { validator: options.validator } : {},
  );
  const reportStatus = (connectorId: number, status: ConnectorStatus) =>
    client.call('StatusNotification', {
      connectorId,
      errorCode: 'NoError',
      status,
      timestamp: now(),
    });

  try {
    const boot = await client.call('BootNotification', {
      chargePointVendor: 'Voltline',
      chargePointModel: 'SimCharger',
      firmwareVersion: '0.1.0',
    });
    if (boot.status !== 'Accepted') throw new Error(`BootNotification was ${boot.status}`);
    await client.call('Heartbeat', {});
    await reportStatus(0, 'Available');
    await reportStatus(CONNECTOR_ID, 'Available');

    clock.advance(30_000);
    const { idTagInfo } = await client.call('Authorize', { idTag: options.idTag });
    if (idTagInfo.status !== 'Accepted') {
      throw new Error(`id tag ${options.idTag} was ${idTagInfo.status}`);
    }
    await reportStatus(CONNECTOR_ID, 'Preparing');

    clock.advance(10_000);
    const startedAt = clock.now();
    const startRequest = {
      connectorId: CONNECTOR_ID,
      idTag: options.idTag,
      meterStart: meter.beginSession(),
      timestamp: startedAt.toISOString(),
    };
    const { transactionId } = await client.call('StartTransaction', startRequest);
    await reportStatus(CONNECTOR_ID, 'Charging');

    const meterValuesRequests: V16Request<'MeterValues'>[] = [];
    for (let minute = 0; minute < minutes; minute++) {
      chargeOneInterval();
      const request = {
        connectorId: CONNECTOR_ID,
        transactionId,
        meterValue: [
          { timestamp: now(), sampledValue: [register(meter.emit(), 'Sample.Periodic')] },
        ],
      };
      await client.call('MeterValues', request);
      meterValuesRequests.push(request);
    }

    chargeOneInterval();
    const meterStop = meter.emit();
    const stoppedAt = clock.now();
    const stopRequest = {
      transactionId,
      idTag: options.idTag,
      meterStop,
      timestamp: stoppedAt.toISOString(),
      reason: 'EVDisconnected' as const,
      transactionData: [
        {
          timestamp: stoppedAt.toISOString(),
          sampledValue: [register(meterStop, 'Transaction.End')],
        },
      ],
    };
    await client.call('StopTransaction', stopRequest);
    await reportStatus(CONNECTOR_ID, 'Finishing');
    clock.advance(30_000);
    await reportStatus(CONNECTOR_ID, 'Available');

    return {
      chargePointId: options.chargePointId,
      connectorId: CONNECTOR_ID,
      idTag: options.idTag,
      seed: options.seed,
      transactionId,
      startedAt,
      stoppedAt,
      meterStartWh: startRequest.meterStart,
      meterStopWh: meterStop,
      physicalWh: meter.physicalWh,
      evidencedWh: meter.evidencedWh,
      samplesSent: meterValuesRequests.length + 1,
      startRequest,
      meterValuesRequests,
      stopRequest,
    };
  } finally {
    await client.close();
  }
}

/** One energy-register sample, with every field spelled out rather than left to OCPP's defaults. */
function register(wh: number, context: 'Sample.Periodic' | 'Transaction.End'): SampledValue {
  return {
    value: String(wh),
    context,
    measurand: 'Energy.Active.Import.Register',
    location: 'Outlet',
    unit: 'Wh',
  };
}
