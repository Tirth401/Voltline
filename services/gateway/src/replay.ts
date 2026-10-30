import type { AvailabilityStore } from '@voltline/availability';
import { ManualClock } from '@voltline/common';
import type { Pool, Queryable } from '@voltline/db';
import { parseFrame, type Payload, type V16Validator } from '@voltline/ocpp';
import type { Logger } from 'pino';
import { createDispatcher } from './handlers.ts';

/** A CALL a charger sent, as the frame log recorded it, with the answer we sent back. */
export interface RecordedCall {
  at: Date;
  raw: string;
  /** Our CALLRESULT or CALLERROR, if one went out before the connection closed. */
  answer: string | null;
}

/** A charger's CALLs from the frame log, in the order the gateway received them (D-023). */
export async function loadRecordedCalls(
  db: Queryable,
  chargePointId: string,
): Promise<RecordedCall[]> {
  const { rows } = await db.query<RecordedCall>(
    `SELECT call.at, call.raw, answer.raw AS answer
       FROM ocpp_frames call
       LEFT JOIN ocpp_frames answer
         ON answer.charge_point_id = call.charge_point_id
        AND answer.connection_id = call.connection_id
        AND answer.message_id = call.message_id
        AND answer.direction = 'out' AND answer.message_type IN (3, 4)
      WHERE call.charge_point_id = $1 AND call.direction = 'in' AND call.message_type = 2
      ORDER BY call.at, call.connection_id, call.seq`,
    [chargePointId],
  );
  return rows;
}

export interface ReplayOptions {
  chargePointId: string;
  calls: readonly RecordedCall[];
  /** The database to replay into: normally a fresh one, with the charger and its tags registered. */
  db: Pool;
  availability: AvailabilityStore;
  validator: V16Validator;
  logger: Logger;
}

/**
 * Feeds recorded CALLs through the same handlers again, one at a time, in the recorded order, with
 * the clock set to each call's original arrival time (D-023). The bill depends only on these CALLs,
 * so replaying a charger's trace into an empty database reproduces its sessions and their energy.
 *
 * One translation is needed. In OCPP 1.6 the server assigns transaction ids, and the replay
 * database assigns its own, so MeterValues and StopTransaction would point at the wrong sessions.
 * The recorded answer to each StartTransaction says which id the charger was given; the replay
 * maps that to the id it assigned and rewrites later messages to match.
 */
export async function replayCalls(
  options: ReplayOptions,
): Promise<{ replayed: number; answeredWithError: number }> {
  const clock = new ManualClock(0);
  const dispatch = createDispatcher({
    db: options.db,
    availability: options.availability,
    clock,
    heartbeatIntervalSec: 300,
    validator: options.validator,
    validateResponses: false,
  });
  const replayIdFor = new Map<number, number>();

  let replayed = 0;
  let answeredWithError = 0;
  for (const call of options.calls) {
    const parsed = parseFrame(call.raw);
    if (!parsed.ok || parsed.frame.type !== 2) continue;
    const { frame } = parsed;
    clock.set(call.at);
    const outcome = await dispatch(
      options.chargePointId,
      { ...frame, payload: withReplayId(frame.action, frame.payload, replayIdFor) },
      options.logger,
    );
    replayed += 1;
    if ('error' in outcome) {
      answeredWithError += 1;
    } else if (frame.action === 'StartTransaction') {
      const original = transactionIdIn(call.answer);
      const assigned = outcome.result['transactionId'];
      if (original !== undefined && typeof assigned === 'number')
        replayIdFor.set(original, assigned);
    }
  }
  return { replayed, answeredWithError };
}

function withReplayId(action: string, payload: Payload, replayIdFor: Map<number, number>): Payload {
  if (action !== 'MeterValues' && action !== 'StopTransaction') return payload;
  const original = payload['transactionId'];
  const replayId = typeof original === 'number' ? replayIdFor.get(original) : undefined;
  return replayId === undefined ? payload : { ...payload, transactionId: replayId };
}

function transactionIdIn(answer: string | null): number | undefined {
  if (answer === null) return undefined;
  const parsed = parseFrame(answer);
  if (!parsed.ok || parsed.frame.type !== 3) return undefined;
  const id = parsed.frame.payload['transactionId'];
  return typeof id === 'number' ? id : undefined;
}
