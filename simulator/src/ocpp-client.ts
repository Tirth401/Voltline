import {
  OcppCallError,
  parseFrame,
  serializeCall,
  serializeCallError,
  type Payload,
  type V16ChargerAction,
  type V16Request,
  type V16Response,
  type V16Validator,
} from '@voltline/ocpp';
import WebSocket, { type RawData } from 'ws';

export interface ClientOptions {
  /** Check every request we send and every response we get against the official schemas. */
  validator?: V16Validator;
  /** How long to wait for an answer, in real time. Default 10 s. */
  timeoutMs?: number;
}

/** The gateway answered the WebSocket upgrade with an HTTP error instead of a socket. */
export class ConnectionRefusedError extends Error {
  readonly statusCode: number;

  constructor(url: string, statusCode: number) {
    super(`${url} refused the WebSocket upgrade with HTTP ${statusCode}`);
    this.name = 'ConnectionRefusedError';
    this.statusCode = statusCode;
  }
}

interface Waiting {
  messageId: string;
  resolve: (payload: Payload) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

/** The charger's end of an OCPP-J connection. One CALL in flight at a time, as OCPP-J requires. */
export class OcppClient {
  readonly #ws: WebSocket;
  readonly #validator: V16Validator | undefined;
  readonly #timeoutMs: number;
  #queue: Promise<unknown> = Promise.resolve();
  #waiting: Waiting | undefined;
  #nextMessageId = 1;

  static connect(url: string, options: ClientOptions = {}): Promise<OcppClient> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url, ['ocpp1.6']);
      ws.once('open', () => {
        resolve(new OcppClient(ws, options));
      });
      ws.once('unexpected-response', (request, response) => {
        reject(new ConnectionRefusedError(url, response.statusCode ?? 0));
        request.destroy();
      });
      ws.once('error', reject);
    });
  }

  private constructor(ws: WebSocket, options: ClientOptions) {
    this.#ws = ws;
    this.#validator = options.validator;
    this.#timeoutMs = options.timeoutMs ?? 10_000;
    ws.on('message', (data: RawData) => {
      this.#receive(Buffer.isBuffer(data) ? data.toString('utf8') : '');
    });
    ws.on('close', () => {
      this.#fail(new Error('connection closed'));
    });
  }

  /** Sends a valid CALL and returns the CALLRESULT payload. A CALLERROR rejects with OcppCallError. */
  async call<A extends V16ChargerAction>(
    action: A,
    payload: V16Request<A>,
  ): Promise<V16Response<A>> {
    const response = await this.callPayload(action, payload as unknown as Payload);
    return response as unknown as V16Response<A>;
  }

  /** `call`, for code that holds the payload untyped. Checked against the schemas all the same. */
  async callPayload(action: V16ChargerAction, payload: Payload): Promise<Payload> {
    const request = this.#validator?.request(action, payload);
    if (request && !request.ok) throw new Error(`simulator bug: ${action} ${request.description}`);
    const response = await this.callUnchecked(action, payload);
    const check = this.#validator?.response(action, response);
    if (check && !check.ok) throw new Error(`gateway bug: ${action} response ${check.description}`);
    return response;
  }

  /** Sends anything at all, unchecked: for testing how the gateway handles bad input. */
  callUnchecked(action: string, payload: Payload): Promise<Payload> {
    const next = this.#queue.then(() => this.#send(action, payload));
    this.#queue = next.catch(() => undefined);
    return next;
  }

  /**
   * Sends a CALL and hangs up straight away, without waiting for the answer: the network dropping
   * mid-message. The gateway may or may not process it; either way the charger must send it again.
   */
  sendThenClose(action: string, payload: Payload): Promise<void> {
    const next = this.#queue.then(async () => {
      this.#ws.send(serializeCall(String(this.#nextMessageId++), action, payload));
      await this.close();
    });
    this.#queue = next.catch(() => undefined);
    return next;
  }

  close(): Promise<void> {
    return new Promise((resolve) => {
      if (this.#ws.readyState === WebSocket.CLOSED) {
        resolve();
        return;
      }
      this.#ws.once('close', () => {
        resolve();
      });
      this.#ws.close(1000);
    });
  }

  #send(action: string, payload: Payload): Promise<Payload> {
    // Sequential IDs: unique within this connection, which is all OCPP-J asks for (D-006).
    const messageId = String(this.#nextMessageId++);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#waiting = undefined;
        reject(new Error(`${action} got no answer within ${this.#timeoutMs} ms`));
      }, this.#timeoutMs);
      this.#waiting = { messageId, resolve, reject, timer };
      this.#ws.send(serializeCall(messageId, action, payload));
    });
  }

  #receive(text: string): void {
    const parsed = parseFrame(text);
    if (!parsed.ok) return;
    const { frame } = parsed;
    if (frame.type === 2) {
      // The gateway sent us a command. Milestone 1's charger doesn't take any yet.
      this.#ws.send(
        serializeCallError(frame.messageId, 'NotImplemented', `${frame.action} not simulated yet`),
      );
      return;
    }
    const waiting = this.#waiting;
    if (waiting?.messageId !== frame.messageId) return;
    this.#waiting = undefined;
    clearTimeout(waiting.timer);
    if (frame.type === 3) waiting.resolve(frame.payload);
    else
      waiting.reject(
        new OcppCallError(frame.errorCode, frame.errorDescription, frame.errorDetails),
      );
  }

  #fail(error: Error): void {
    const waiting = this.#waiting;
    if (!waiting) return;
    this.#waiting = undefined;
    clearTimeout(waiting.timer);
    waiting.reject(error);
  }
}
