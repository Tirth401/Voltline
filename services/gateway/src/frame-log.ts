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
  /** Records a frame. The promise settles once the frame is stored (or the write failed and was logged). */
  record(frame: FrameRecord): Promise<void>;
}

/**
 * Writes every frame in and out to ocpp_frames (D-023).
 *
 * Frames are written in batches: one INSERT for everything recorded in the last few milliseconds,
 * across all connections. The gateway waits for the batch holding an answer before it sends that
 * answer ("group commit"). So any CALL whose answer reached a charger is in the log, even if the
 * process is killed a moment later; frames lost in a crash belong to CALLs the charger never got
 * an answer for, and it will send those again.
 *
 * A failed write is logged rather than allowed to fail a charger's message: billing has already
 * committed its own evidence, so a gap in the log costs a trace, never money.
 */
export class PostgresFrameLog implements FrameLog {
  readonly #db: Queryable;
  readonly #log: Logger;
  readonly #flushIntervalMs: number;
  readonly #maxBatch: number;
  #buffer: FrameRecord[] = [];
  #batch: PromiseWithResolvers<void> | undefined;
  #timer: NodeJS.Timeout | undefined;
  #writing: Promise<void> = Promise.resolve();

  constructor(
    db: Queryable,
    logger: Logger,
    options: { flushIntervalMs?: number; maxBatch?: number } = {},
  ) {
    this.#db = db;
    this.#log = logger;
    this.#flushIntervalMs = options.flushIntervalMs ?? 5;
    this.#maxBatch = options.maxBatch ?? 500;
  }

  record(frame: FrameRecord): Promise<void> {
    this.#buffer.push(frame);
    this.#batch ??= Promise.withResolvers<void>();
    const written = this.#batch.promise;
    if (this.#buffer.length >= this.#maxBatch) {
      void this.flush();
    } else {
      this.#timer ??= setTimeout(() => {
        void this.flush();
      }, this.#flushIntervalMs);
    }
    return written;
  }

  /** Writes everything recorded so far. Await it before reading ocpp_frames. */
  flush(): Promise<void> {
    clearTimeout(this.#timer);
    this.#timer = undefined;
    const frames = this.#buffer;
    const batch = this.#batch;
    this.#buffer = [];
    this.#batch = undefined;
    // Batches are written strictly one after another, so a frame is never stored before an
    // earlier one from the same connection.
    this.#writing = this.#writing.then(async () => {
      await this.#write(frames);
      batch?.resolve();
    });
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
