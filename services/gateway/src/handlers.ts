import type { AvailabilityStore } from '@voltline/availability';
import {
  authorizeIdTag,
  recordMeterValues,
  startTransaction,
  stopTransaction,
  type MeterSample,
} from '@voltline/billing';
import type { Clock } from '@voltline/common';
import type { Pool } from '@voltline/db';
import {
  V16_ACTIONS,
  type Call,
  type Payload,
  type V16ChargerAction,
  type V16MeterValue,
  type V16Request,
  type V16Response,
  type V16Sender,
  type V16Validator,
} from '@voltline/ocpp';
import type { Logger } from 'pino';
import type { CallOutcome } from './connection.ts';

export interface HandlerDeps {
  db: Pool;
  availability: AvailabilityStore;
  clock: Clock;
  /** Told to chargers in BootNotification.conf: how often to send a Heartbeat. */
  heartbeatIntervalSec: number;
}

interface HandlerContext extends HandlerDeps {
  chargePointId: string;
  /** Server time when the CALL arrived. */
  now: Date;
  log: Logger;
}

type Handler<A extends V16ChargerAction> = (
  ctx: HandlerContext,
  request: V16Request<A>,
) => Promise<V16Response<A>>;

/**
 * The answer to every action a charger can send in OCPP 1.6. Each handler has committed its
 * evidence by the time it returns, and only then does the CALLRESULT go out (D-005).
 */
const handlers: { [A in V16ChargerAction]: Handler<A> } = {
  BootNotification: async (ctx, request) => {
    // Updates details only: the gateway refused the socket if the charger wasn't registered (D-017).
    await ctx.db.query(
      `UPDATE charge_points
          SET vendor = $2, model = $3, serial_number = $4, firmware_version = $5, last_boot_at = $6
        WHERE id = $1`,
      [
        ctx.chargePointId,
        request.chargePointVendor,
        request.chargePointModel,
        request.chargePointSerialNumber ?? null,
        request.firmwareVersion ?? null,
        ctx.now,
      ],
    );
    return {
      status: 'Accepted',
      currentTime: ctx.now.toISOString(),
      interval: ctx.heartbeatIntervalSec,
    };
  },

  Heartbeat: (ctx) => Promise.resolve({ currentTime: ctx.now.toISOString() }),

  StatusNotification: async (ctx, request) => {
    await ctx.availability.record({
      chargePointId: ctx.chargePointId,
      connectorId: request.connectorId,
      status: request.status,
      errorCode: request.errorCode,
      info: request.info,
      vendorErrorCode: request.vendorErrorCode,
      // timestamp is optional in 1.6. Without one, the best we have is when it arrived.
      timestamp: request.timestamp === undefined ? ctx.now : new Date(request.timestamp),
    });
    return {};
  },

  Authorize: async (ctx, request) => ({
    idTagInfo: await authorizeIdTag(ctx.db, request.idTag, ctx.now),
  }),

  StartTransaction: async (ctx, request) => {
    const { transactionId, idTagInfo, created } = await startTransaction(ctx.db, {
      chargePointId: ctx.chargePointId,
      connectorId: request.connectorId,
      idTag: request.idTag,
      meterStartWh: request.meterStart,
      startedAt: new Date(request.timestamp),
      now: ctx.now,
    });
    if (!created)
      ctx.log.info({ transactionId }, 'StartTransaction retried: same session returned');
    return { transactionId, idTagInfo };
  },

  MeterValues: async (ctx, request) => {
    const { rebilled } = await recordMeterValues(ctx.db, {
      chargePointId: ctx.chargePointId,
      connectorId: request.connectorId,
      transactionId: request.transactionId,
      samples: toSamples(request.meterValue),
    });
    if (rebilled) {
      ctx.log.info(
        { transactionId: request.transactionId, ...rebilled },
        rebilled.corrected
          ? 'late readings changed a settled bill: recorded a correction (D-034)'
          : 'late readings changed a stopped session: billed again (D-024)',
      );
    }
    return {};
  },

  StopTransaction: async (ctx, request) => {
    const result = await stopTransaction(ctx.db, {
      chargePointId: ctx.chargePointId,
      transactionId: request.transactionId,
      meterStopWh: request.meterStop,
      stoppedAt: new Date(request.timestamp),
      reason: request.reason,
      samples: toSamples(request.transactionData ?? []),
    });
    if (result.outcome === 'unknown') {
      ctx.log.warn(
        { transactionId: request.transactionId },
        'StopTransaction for an unknown session: acknowledged anyway (D-008)',
      );
    } else if (result.outcome === 'duplicate' && !result.matches) {
      ctx.log.warn(
        { transactionId: request.transactionId },
        'a second, different StopTransaction: kept the first',
      );
    }
    // This idTagInfo is about the tag that ended the session, if the charger names one.
    return request.idTag === undefined
      ? {}
      : { idTagInfo: await authorizeIdTag(ctx.db, request.idTag, ctx.now) };
  },

  DataTransfer: () => Promise.resolve({ status: 'UnknownVendorId' }),
  DiagnosticsStatusNotification: () => Promise.resolve({}),
  FirmwareStatusNotification: () => Promise.resolve({}),
};

/** OCPP 1.6 meter values as samples, with the spec's defaults filled in for omitted fields. */
function toSamples(meterValues: readonly V16MeterValue[]): MeterSample[] {
  return meterValues.flatMap((meterValue) =>
    meterValue.sampledValue.map((sampled) => ({
      ts: new Date(meterValue.timestamp),
      measurand: sampled.measurand ?? 'Energy.Active.Import.Register',
      phase: sampled.phase ?? '',
      location: sampled.location ?? 'Outlet',
      context: sampled.context ?? 'Sample.Periodic',
      unit: sampled.unit ?? 'Wh',
      rawValue: sampled.value,
    })),
  );
}

export interface DispatcherOptions extends HandlerDeps {
  validator: V16Validator;
  /** Also check our own responses against the schemas: on in tests, to catch our own bugs. */
  validateResponses: boolean;
}

export type Dispatcher = (chargePointId: string, call: Call, log: Logger) => Promise<CallOutcome>;

/** Turns one CALL into an answer: is the action one a charger may send, is the payload valid? */
export function createDispatcher(options: DispatcherOptions): Dispatcher {
  return async (chargePointId, call, log) => {
    const sender = (V16_ACTIONS as Record<string, V16Sender | undefined>)[call.action];
    if (sender === undefined) {
      return { error: 'NotImplemented', description: `unknown action ${call.action}` };
    }
    if (sender === 'csms') {
      return {
        error: 'NotSupported',
        description: `${call.action} is sent by the CSMS, not by chargers`,
      };
    }
    const action = call.action as V16ChargerAction;
    const valid = options.validator.request(action, call.payload);
    if (!valid.ok) return { error: valid.errorCode, description: valid.description };

    const handle = handlers[action] as unknown as (
      ctx: HandlerContext,
      request: Payload,
    ) => Promise<Payload>;
    const result = await handle(
      { ...options, chargePointId, now: options.clock.now(), log },
      call.payload,
    );

    if (options.validateResponses) {
      const check = options.validator.response(action, result);
      if (!check.ok) {
        log.error({ action, problem: check.description }, 'our own response broke the schema');
        return { error: 'InternalError', description: 'response failed schema validation' };
      }
    }
    return { result };
  };
}
