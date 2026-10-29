import { randomUUID } from 'node:crypto';
import {
  OcppCallError,
  parseFrame,
  serializeCall,
  serializeCallError,
  serializeCallResult,
  type Call,
  type CallError,
  type CallResult,
  type OcppErrorCode,
  type Payload,
} from '@voltline/ocpp';
import type { Logger } from 'pino';

/** The slice of a WebSocket a connection needs. Tests pass a fake. */
export interface FrameSocket {
  send(data: string): void;
  close(code?: number, reason?: string): void;
}

/** How a charger's CALL is answered: a result payload, or an OCPP error. */
export type CallOutcome = { result: Payload } | { error: OcppErrorCode; description: string };

export interface ConnectionOptions {
  chargePointId: string;
  socket: FrameSocket;
  /** Answers one CALL from the charger. Called one at a time, in arrival order. */
  answer: (call: Call) => Promise<CallOutcome>;
  logger: Logger;
  /** How long to wait for the charger to answer a CALL we sent. */
  callTimeoutMs: number;
}

interface PendingCall {
  action: string;
  resolve: (payload: Payload) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

/**
 * One charger's WebSocket, speaking OCPP-J. Two kinds of traffic, handled differently (D-018):
 *
 * - CALLs from the charger are answered strictly one at a time, in arrival order, so a session's
 *   StartTransaction is committed before its first MeterValues is handled.
 * - CALLRESULTs and CALLERRORs answer CALLs *we* sent. They're settled the moment they arrive and
 *   never queue behind the charger's CALLs: a handler that waits on the charger's answer to one of
 *   our CALLs would otherwise deadlock.
 */
export class ChargerConnection {
  readonly chargePointId: string;
  readonly #socket: FrameSocket;
  readonly #answer: ConnectionOptions['answer'];
  readonly #log: Logger;
  readonly #callTimeoutMs: number;
  readonly #pending = new Map<string, PendingCall>();
  #inbound: Promise<void> = Promise.resolve();
  #outbound: Promise<unknown> = Promise.resolve();
  #closed = false;

  constructor(options: ConnectionOptions) {
    this.chargePointId = options.chargePointId;
    this.#socket = options.socket;
    this.#answer = options.answer;
    this.#log = options.logger;
    this.#callTimeoutMs = options.callTimeoutMs;
  }

  /** Every text frame from the socket comes through here. */
  receive(text: string): void {
    const parsed = parseFrame(text);
    if (!parsed.ok) {
      this.#log.warn({ reason: parsed.reason, frame: text.slice(0, 200) }, 'malformed frame');
      // Only a CALL can be answered, and only if we know its message ID.
      if (parsed.messageType === 2 && parsed.messageId !== undefined) {
        this.#send(serializeCallError(parsed.messageId, 'FormationViolation', parsed.reason));
      }
      return;
    }
    const { frame } = parsed;
    if (frame.type === 2) {
      this.#inbound = this.#inbound
        .then(() => this.#handleCall(frame))
        .catch((error: unknown) => {
          this.#log.error({ err: error }, 'failed to answer a CALL');
        });
    } else {
      this.#settle(frame);
    }
  }

  /**
   * Sends a CALL to the charger and resolves with its CALLRESULT payload. CALLs go out one at a
   * time: OCPP-J says not to send another until the previous one is answered or has timed out.
   */
  call(action: string, payload: Payload): Promise<Payload> {
    const next = this.#outbound.then(() => this.#callNow(action, payload));
    this.#outbound = next.catch(() => undefined); // a failed CALL mustn't block the next one
    return next;
  }

  /** Call when the socket has closed: fails every CALL still waiting for an answer. */
  closed(): void {
    this.#closed = true;
    for (const [messageId, pending] of this.#pending) {
      clearTimeout(pending.timer);
      this.#pending.delete(messageId);
      pending.reject(new Error(`connection closed before ${pending.action} was answered`));
    }
  }

  close(code: number, reason: string): void {
    this.#socket.close(code, reason);
  }

  async #handleCall(call: Call): Promise<void> {
    let outcome: CallOutcome;
    try {
      outcome = await this.#answer(call);
    } catch (error) {
      this.#log.error({ err: error, action: call.action }, 'handler failed');
      outcome = { error: 'InternalError', description: 'internal error' };
    }
    this.#send(
      'result' in outcome
        ? serializeCallResult(call.messageId, outcome.result)
        : serializeCallError(call.messageId, outcome.error, outcome.description),
    );
  }

  #callNow(action: string, payload: Payload): Promise<Payload> {
    if (this.#closed) return Promise.reject(new Error(`connection closed; ${action} not sent`));
    const messageId = randomUUID(); // 36 characters: exactly OCPP-J's limit
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(messageId);
        reject(new Error(`${action} got no answer within ${this.#callTimeoutMs} ms`));
      }, this.#callTimeoutMs);
      this.#pending.set(messageId, { action, resolve, reject, timer });
      this.#send(serializeCall(messageId, action, payload));
    });
  }

  #settle(frame: CallResult | CallError): void {
    const pending = this.#pending.get(frame.messageId);
    if (!pending) {
      // Arrived after its timeout, or was never ours. There's nothing to answer: you can't reply
      // to a reply.
      this.#log.warn({ messageId: frame.messageId }, 'answer to an unknown or expired CALL');
      return;
    }
    this.#pending.delete(frame.messageId);
    clearTimeout(pending.timer);
    if (frame.type === 3) {
      pending.resolve(frame.payload);
    } else {
      pending.reject(
        new OcppCallError(frame.errorCode, frame.errorDescription, frame.errorDetails),
      );
    }
  }

  #send(text: string): void {
    if (!this.#closed) this.#socket.send(text);
  }
}
