import { randomUUID } from 'node:crypto';
import type { Redis } from 'ioredis';
import type { ConnectionRegistry } from './registry.ts';

export type CommandPayload = Record<string, unknown>;

/** A command for one charger, as the gateway holding its socket receives it. */
export interface CommandRequest {
  chargePointId: string;
  action: string;
  payload: CommandPayload;
}

/** How a command ended. */
export type CommandOutcome =
  /** The charger answered with a CALLRESULT. */
  | { status: 'answered'; result: CommandPayload }
  /** We refused to send it: not a command the CSMS sends, or a payload that breaks the schema. */
  | { status: 'invalid'; description: string }
  /** The charger answered with a CALLERROR. */
  | { status: 'charger-error'; errorCode: string; description: string }
  /** No gateway holds a connection to this charger. */
  | { status: 'not-connected' }
  /** The command went out, but no answer came back in time. */
  | { status: 'timeout' };

/** The other gateway should close this connection: the charger has reconnected elsewhere. */
export interface SupersededNotice {
  chargePointId: string;
  connectionId: string;
}

type Message =
  | ({ kind: 'command'; requestId: string; replyTo: string } & CommandRequest)
  | ({ kind: 'superseded' } & SupersededNotice)
  | { kind: 'reply'; requestId: string; outcome: CommandOutcome };

export interface GatewayHandlers {
  command(request: CommandRequest): Promise<CommandOutcome>;
  superseded(notice: SupersededNotice): void;
}

/**
 * Carries commands from any process (the API, say) to the gateway that holds a charger's socket,
 * over Redis pub/sub, and carries the charger's answer back (D-030).
 *
 * Deliberately not a durable queue. A RemoteStartTransaction that arrives a minute late is worse
 * than one that fails fast: the caller can retry with fresh information. So a command either gets
 * an answer within the timeout, or the caller is told it didn't.
 */
export class CommandBus {
  readonly #publisher: Redis;
  readonly #subscriber: Redis;
  readonly #registry: ConnectionRegistry;
  readonly #prefix: string;
  readonly #timeoutMs: number;
  readonly #replyChannel: string;
  readonly #pending = new Map<string, (outcome: CommandOutcome) => void>();
  readonly #channels = new Map<string, (message: Message) => void>();

  constructor(
    redis: Redis,
    registry: ConnectionRegistry,
    options: { keyPrefix?: string; timeoutMs?: number } = {},
  ) {
    this.#publisher = redis;
    // A Redis connection that subscribes can do nothing else, so it gets its own.
    this.#subscriber = redis.duplicate();
    this.#registry = registry;
    this.#prefix = options.keyPrefix ?? 'voltline:';
    this.#timeoutMs = options.timeoutMs ?? 30_000;
    this.#replyChannel = `${this.#prefix}replies:${randomUUID()}`;
    this.#subscriber.on('message', (channel: string, raw: string) => {
      const handle = this.#channels.get(channel);
      if (handle) handle(JSON.parse(raw) as Message);
    });
  }

  /** Sends a command to whichever gateway holds the charger, and waits for the outcome. */
  async send(
    chargePointId: string,
    action: string,
    payload: CommandPayload,
  ): Promise<CommandOutcome> {
    const owner = await this.#registry.owner(chargePointId);
    if (!owner) return { status: 'not-connected' };
    await this.#listen(this.#replyChannel, (message) => {
      if (message.kind === 'reply') this.#pending.get(message.requestId)?.(message.outcome);
    });

    const requestId = randomUUID();
    const outcome = new Promise<CommandOutcome>((resolve) => {
      const timer = setTimeout(() => {
        settle({ status: 'timeout' });
      }, this.#timeoutMs);
      const settle = (result: CommandOutcome): void => {
        clearTimeout(timer);
        this.#pending.delete(requestId);
        resolve(result);
      };
      this.#pending.set(requestId, settle);
    });

    const message: Message = {
      kind: 'command',
      requestId,
      replyTo: this.#replyChannel,
      chargePointId,
      action,
      payload,
    };
    const receivers = await this.#publisher.publish(
      this.#gatewayChannel(owner.gatewayId),
      JSON.stringify(message),
    );
    // Nobody subscribed: the gateway named in the registry is gone (crashed before the charger
    // reconnected elsewhere). Say so now rather than waiting out the timeout.
    if (receivers === 0) this.#pending.get(requestId)?.({ status: 'not-connected' });
    return outcome;
  }

  /** Gateway side: handles commands and notices addressed to this gateway. */
  async serve(gatewayId: string, handlers: GatewayHandlers): Promise<void> {
    await this.#listen(this.#gatewayChannel(gatewayId), (message) => {
      if (message.kind === 'superseded') {
        handlers.superseded({
          chargePointId: message.chargePointId,
          connectionId: message.connectionId,
        });
      } else if (message.kind === 'command') {
        void handlers
          .command({
            chargePointId: message.chargePointId,
            action: message.action,
            payload: message.payload,
          })
          .then((outcome) => this.#reply(message.replyTo, message.requestId, outcome));
      }
    });
  }

  /** Tells another gateway to close a connection the charger has replaced. */
  async notifySuperseded(gatewayId: string, notice: SupersededNotice): Promise<void> {
    const message: Message = { kind: 'superseded', ...notice };
    await this.#publisher.publish(this.#gatewayChannel(gatewayId), JSON.stringify(message));
  }

  async close(): Promise<void> {
    for (const settle of this.#pending.values()) settle({ status: 'timeout' });
    await this.#subscriber.quit();
  }

  async #reply(replyTo: string, requestId: string, outcome: CommandOutcome): Promise<void> {
    const message: Message = { kind: 'reply', requestId, outcome };
    await this.#publisher.publish(replyTo, JSON.stringify(message));
  }

  async #listen(channel: string, handle: (message: Message) => void): Promise<void> {
    if (this.#channels.has(channel)) return;
    this.#channels.set(channel, handle);
    await this.#subscriber.subscribe(channel);
  }

  #gatewayChannel(gatewayId: string): string {
    return `${this.#prefix}gateway:${gatewayId}`;
  }
}
