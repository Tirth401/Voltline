import { withTransaction, type Pool, type Queryable } from '@voltline/db';
import { computeEnergyWh, type RegisterReading } from './energy.ts';
import { authorizeIdTag, type AuthorizationStatus, type IdTagInfo } from './id-tags.ts';
import { parseEnergyWh, type MeterSample } from './meter-sample.ts';

/** The register we bill from: total active import energy at the outlet, no single phase. */
const BILLING_MEASURAND = 'Energy.Active.Import.Register';

export interface StartTransactionInput {
  chargePointId: string;
  connectorId: number;
  idTag: string;
  meterStartWh: number;
  /** The charger's timestamp for the start, never the time we received it. */
  startedAt: Date;
  /** Server time, for checking id tag expiry. */
  now: Date;
}

export interface StartTransactionResult {
  transactionId: number;
  idTagInfo: IdTagInfo;
  /** False when this was a retry of a StartTransaction already recorded. */
  created: boolean;
}

/**
 * Records a StartTransaction exactly once (D-006).
 *
 * A retry, whether after a lost CALLRESULT, a reconnect or a gateway crash, carries the same
 * charger, connector, start time and start reading, finds the session its first attempt created,
 * and gets the same transactionId and authorization status back.
 *
 * The session is recorded whatever the authorization verdict: a charger that started offline may
 * already have delivered energy, and that still has to be accounted for (D-008).
 */
export async function startTransaction(
  pool: Pool,
  input: StartTransactionInput,
): Promise<StartTransactionResult> {
  return withTransaction(pool, async (client) => {
    const existing = await findStart(client, input);
    if (existing) return { ...existing, created: false };

    const idTagInfo = await authorizeIdTag(client, input.idTag, input.now);
    const { rows } = await client.query<{ transaction_id: number }>(
      `INSERT INTO transactions
         (charge_point_id, connector_id, id_tag, auth_status, started_at, meter_start_wh)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT ON CONSTRAINT start_idempotency DO NOTHING
       RETURNING transaction_id`,
      [
        input.chargePointId,
        input.connectorId,
        input.idTag,
        idTagInfo.status,
        input.startedAt,
        input.meterStartWh,
      ],
    );
    const inserted = rows[0];
    if (inserted) return { transactionId: inserted.transaction_id, idTagInfo, created: true };

    // Another copy of this StartTransaction (on another gateway, say) committed first.
    const winner = await findStart(client, input);
    if (!winner) throw new Error('StartTransaction conflicted, but no matching session exists');
    return { ...winner, created: false };
  });
}

async function findStart(
  db: Queryable,
  input: StartTransactionInput,
): Promise<{ transactionId: number; idTagInfo: IdTagInfo } | undefined> {
  const { rows } = await db.query<{ transaction_id: number; auth_status: AuthorizationStatus }>(
    `SELECT transaction_id, auth_status
       FROM transactions
      WHERE charge_point_id = $1 AND connector_id = $2 AND started_at = $3 AND meter_start_wh = $4`,
    [input.chargePointId, input.connectorId, input.startedAt, input.meterStartWh],
  );
  const row = rows[0];
  return row && { transactionId: row.transaction_id, idTagInfo: { status: row.auth_status } };
}

export interface MeterValuesInput {
  chargePointId: string;
  connectorId: number;
  /** Optional in MeterValues.req: clock-aligned readings belong to no session. */
  transactionId?: number;
  samples: readonly MeterSample[];
}

/**
 * Stores every sampled value once. A resent reading hits the one-value-per-instant key and is
 * dropped (D-013). Returns how many readings were new.
 */
export async function recordMeterValues(db: Queryable, input: MeterValuesInput): Promise<number> {
  const { samples } = input;
  if (samples.length === 0) return 0;
  const result = await db.query(
    `INSERT INTO meter_readings
       (charge_point_id, connector_id, transaction_id,
        ts, measurand, phase, location, context, unit, raw_value, value_wh)
     SELECT $1::text, $2::int, $3::int, sample.*
       FROM unnest($4::timestamptz[], $5::text[], $6::text[], $7::text[], $8::text[], $9::text[],
                   $10::text[], $11::bigint[]) AS sample
     ON CONFLICT ON CONSTRAINT one_value_per_instant DO NOTHING`,
    [
      input.chargePointId,
      input.connectorId,
      input.transactionId ?? null,
      samples.map((sample) => sample.ts),
      samples.map((sample) => sample.measurand),
      samples.map((sample) => sample.phase),
      samples.map((sample) => sample.location),
      samples.map((sample) => sample.context),
      samples.map((sample) => sample.unit),
      samples.map((sample) => sample.rawValue),
      samples.map((sample) =>
        sample.measurand.startsWith('Energy.')
          ? (parseEnergyWh(sample.rawValue, sample.unit) ?? null)
          : null,
      ),
    ],
  );
  return result.rowCount ?? 0;
}

export interface StopTransactionInput {
  /** The identity of the connection it arrived on: a charger can only stop its own sessions. */
  chargePointId: string;
  transactionId: number;
  meterStopWh: number;
  /** The charger's timestamp for the stop. */
  stoppedAt: Date;
  reason?: string;
  /** StopTransaction.req's transactionData. */
  samples: readonly MeterSample[];
}

export type StopTransactionResult =
  | { outcome: 'stopped'; energyWh: number; resetsDetected: number }
  /** Already stopped. `matches` is false if this copy reports a different stop. */
  | { outcome: 'duplicate'; energyWh: number; resetsDetected: number; matches: boolean }
  /** No such session for this charger. The gateway still acknowledges it (D-008). */
  | { outcome: 'unknown' };

/**
 * Records a StopTransaction once and bills the session from all its evidence (D-009).
 *
 * Runs under a row lock on the session, so two copies of the same stop (a retry racing the
 * original on another gateway, say) can't interleave.
 */
export async function stopTransaction(
  pool: Pool,
  input: StopTransactionInput,
): Promise<StopTransactionResult> {
  return withTransaction(pool, async (client) => {
    const { rows } = await client.query<{
      connector_id: number;
      started_at: Date;
      meter_start_wh: number;
      stopped_at: Date | null;
      meter_stop_wh: number | null;
      energy_wh: number | null;
      resets_detected: number;
    }>(
      `SELECT connector_id, started_at, meter_start_wh, stopped_at, meter_stop_wh,
              energy_wh, resets_detected
         FROM transactions
        WHERE transaction_id = $1 AND charge_point_id = $2
          FOR UPDATE`,
      [input.transactionId, input.chargePointId],
    );
    const session = rows[0];
    if (!session) return { outcome: 'unknown' };

    if (session.stopped_at !== null) {
      return {
        outcome: 'duplicate',
        energyWh: session.energy_wh ?? 0,
        resetsDetected: session.resets_detected,
        matches:
          session.stopped_at.getTime() === input.stoppedAt.getTime() &&
          session.meter_stop_wh === input.meterStopWh,
      };
    }

    await recordMeterValues(client, {
      chargePointId: input.chargePointId,
      connectorId: session.connector_id,
      transactionId: input.transactionId,
      samples: input.samples,
    });
    const { energyWh, resetsDetected } = computeEnergyWh(
      { ts: session.started_at, wh: session.meter_start_wh },
      await registerReadings(client, input.chargePointId, input.transactionId),
      { ts: input.stoppedAt, wh: input.meterStopWh },
    );
    await client.query(
      `UPDATE transactions
          SET stopped_at = $2, meter_stop_wh = $3, stop_reason = $4, stop_received_at = now(),
              energy_wh = $5, resets_detected = $6, state = 'stopped'
        WHERE transaction_id = $1`,
      [
        input.transactionId,
        input.stoppedAt,
        input.meterStopWh,
        input.reason ?? null,
        energyWh,
        resetsDetected,
      ],
    );
    return { outcome: 'stopped', energyWh, resetsDetected };
  });
}

async function registerReadings(
  db: Queryable,
  chargePointId: string,
  transactionId: number,
): Promise<RegisterReading[]> {
  const { rows } = await db.query<{ ts: Date; value_wh: number }>(
    `SELECT ts, value_wh
       FROM meter_readings
      WHERE transaction_id = $1 AND charge_point_id = $2
        AND measurand = $3 AND phase = '' AND location = 'Outlet' AND value_wh IS NOT NULL`,
    [transactionId, chargePointId, BILLING_MEASURAND],
  );
  return rows.map((row) => ({ ts: row.ts, wh: row.value_wh }));
}
