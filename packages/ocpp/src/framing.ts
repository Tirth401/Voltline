/**
 * OCPP-J framing. Every WebSocket text message is a JSON array:
 *
 *   CALL        [2, messageId, action, payload]
 *   CALLRESULT  [3, messageId, payload]
 *   CALLERROR   [4, messageId, errorCode, errorDescription, errorDetails]
 *
 * A CALLRESULT or CALLERROR carries the messageId of the CALL it answers; that's the only link
 * between a request and its response.
 */
import type { OcppErrorCode } from './errors.ts';

export type Payload = Record<string, unknown>;

export interface Call {
  type: 2;
  messageId: string;
  action: string;
  payload: Payload;
}

export interface CallResult {
  type: 3;
  messageId: string;
  payload: Payload;
}

export interface CallError {
  type: 4;
  messageId: string;
  errorCode: string;
  errorDescription: string;
  errorDetails: Payload;
}

export type Frame = Call | CallResult | CallError;

/** OCPP-J caps message IDs at 36 characters, exactly the length of a UUID. */
export const MAX_MESSAGE_ID_LENGTH = 36;

export type ParseResult =
  | { ok: true; frame: Frame }
  | {
      ok: false;
      reason: string;
      /** Known when the frame got far enough to name one; needed to answer with a CALLERROR. */
      messageId?: string;
      messageType?: unknown;
    };

export function parseFrame(text: string): ParseResult {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return { ok: false, reason: 'not valid JSON' };
  }
  if (!Array.isArray(data)) return { ok: false, reason: 'not a JSON array' };

  const items = data as unknown[];
  const [messageType, messageId] = items;
  if (
    typeof messageId !== 'string' ||
    messageId.length === 0 ||
    messageId.length > MAX_MESSAGE_ID_LENGTH
  ) {
    return { ok: false, reason: 'message ID must be a string of 1-36 characters', messageType };
  }
  const fail = (reason: string): ParseResult => ({ ok: false, reason, messageId, messageType });

  switch (messageType) {
    case 2: {
      const [, , action, payload] = items;
      if (items.length !== 4 || typeof action !== 'string' || !isPayload(payload)) {
        return fail('a CALL must be [2, messageId, action, {payload}]');
      }
      return { ok: true, frame: { type: 2, messageId, action, payload } };
    }
    case 3: {
      const [, , payload] = items;
      if (items.length !== 3 || !isPayload(payload)) {
        return fail('a CALLRESULT must be [3, messageId, {payload}]');
      }
      return { ok: true, frame: { type: 3, messageId, payload } };
    }
    case 4: {
      const [, , errorCode, errorDescription, errorDetails] = items;
      if (
        items.length !== 5 ||
        typeof errorCode !== 'string' ||
        typeof errorDescription !== 'string' ||
        !isPayload(errorDetails)
      ) {
        return fail('a CALLERROR must be [4, messageId, errorCode, description, {details}]');
      }
      return { ok: true, frame: { type: 4, messageId, errorCode, errorDescription, errorDetails } };
    }
    default:
      return fail(`unknown message type ${JSON.stringify(messageType)}`);
  }
}

export function serializeCall(messageId: string, action: string, payload: Payload): string {
  return JSON.stringify([2, messageId, action, payload]);
}

export function serializeCallResult(messageId: string, payload: Payload): string {
  return JSON.stringify([3, messageId, payload]);
}

export function serializeCallError(
  messageId: string,
  errorCode: OcppErrorCode,
  errorDescription = '',
  errorDetails: Payload = {},
): string {
  return JSON.stringify([4, messageId, errorCode, errorDescription, errorDetails]);
}

function isPayload(value: unknown): value is Payload {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
