import type { Queryable } from '@voltline/db';
import { parseFrame } from '@voltline/ocpp';
import type { Logger } from 'pino';

/** One frame exactly as it crossed the wire. */
export interface FrameRecord {
  chargePointId: string;
  /** Unique per WebSocket connection. */
  connectionId: string;
  /** Position within its connection, counting both directions: 1, 2, 3… */
  seq: number;
  at: Date;
  direction: 'in' | 'out';
  raw: string;
}

export interface FrameLog {
  record(frame: FrameRecord): void;
}

/**
 * Writes every frame in and out to ocpp_frames, in batches, off the critical path (D-023).
 *
 * The log is for replaying and debugging, not evidence: billing commits evidence itself before
 * any ack goes out. So frames buffered when a process dies cost us a trace, never money, and a
 * failed write is logged rather than allowed to fail a charger's message.
 */
export class PostgresFrameLog implements FrameLog {
  readonly #db: Queryable;
  readonly #log: Logger;
  readonly #flushIntervalMs: number;
  readonly #maxBatch: number;
  #buffer: FrameRecord[] = [];
  #timer: NodeJS.Timeout | undefined;
  #writing: Promise<void> = Promise.resolve();

  constructor(
    db: Queryable,
    logger: Logger,
    options: { flushIntervalMs?: number; maxBatch?: number } = {},
  ) {
    this.#db = db;
    this.#log = logger;
    this.#flushIntervalMs = options.flushIntervalMs ?? 200;
    this.#maxBatch = options.maxBatch ?? 500;
  }

  record(frame: FrameRecord): void {
    this.#buffer.push(frame);
    if (this.#buffer.length >= this.#maxBatch) {
      void this.flush();
    } else {
      this.#timer ??= setTimeout(() => {
        void this.flush();
      }, this.#flushIntervalMs);
    }
  }

  /** Writes everything recorded so far. Await it before reading ocpp_frames. */
  flush(): Promise<void> {
    clearTimeout(this.#timer);
    this.#timer = undefined;
    const batch = this.#buffer;
    this.#buffer = [];
    this.#writing = this.#writing.then(() => this.#write(batch));
    return this.#writing;
  }

  async #write(batch: readonly FrameRecord[]): Promise<void> {
    if (batch.length === 0) return;
    const described = batch.map((frame) => ({ frame, ...describe(frame.raw) }));
    try {
      await this.#db.query(
        `INSERT INTO ocpp_frames
           (charge_point_id, connection_id, seq, at, direction, message_type, message_id, action, raw)
         SELECT * FROM unnest($1::text[], $2::text[], $3::int[], $4::timestamptz[], $5::text[],
                              $6::smallint[], $7::text[], $8::text[], $9::text[])`,
        [
          described.map(({ frame }) => frame.chargePointId),
          described.map(({ frame }) => frame.connectionId),
          described.map(({ frame }) => frame.seq),
          described.map(({ frame }) => frame.at),
          described.map(({ frame }) => frame.direction),
          described.map(({ messageType }) => messageType),
          described.map(({ messageId }) => messageId),
          described.map(({ action }) => action),
          described.map(({ frame }) => frame.raw),
        ],
      );
    } catch (error) {
      this.#log.error({ err: error, frames: batch.length }, 'lost frames: could not log them');
    }
  }
}

function describe(raw: string): {
  messageType: number | null;
  messageId: string | null;
  action: string | null;
} {
  const parsed = parseFrame(raw);
  if (!parsed.ok) {
    const { messageType } = parsed;
    return {
      messageType: messageType === 2 || messageType === 3 || messageType === 4 ? messageType : null,
      messageId: parsed.messageId ?? null,
      action: null,
    };
  }
  const { frame } = parsed;
  return {
    messageType: frame.type,
    messageId: frame.messageId,
    action: frame.type === 2 ? frame.action : null,
  };
}
