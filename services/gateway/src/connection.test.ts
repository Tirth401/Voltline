import type { Call } from '@voltline/ocpp';
import { pino } from 'pino';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ChargerConnection, type CallOutcome, type FrameSocket } from './connection.ts';

/** Records what the connection sends, already parsed. */
class FakeSocket implements FrameSocket {
  readonly sent: unknown[][] = [];
  send(data: string): void {
    this.sent.push(JSON.parse(data) as unknown[]);
  }
  close(): void {}
}

const logger = pino({ level: 'silent' });

function connect(answer: (call: Call) => Promise<CallOutcome>, callTimeoutMs = 1_000) {
  const socket = new FakeSocket();
  const connection = new ChargerConnection({
    chargePointId: 'CP-1',
    socket,
    logger,
    callTimeoutMs,
    answer,
  });
  return { connection, socket };
}

const nextTick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

afterEach(() => {
  vi.useRealTimers();
});

describe('ChargerConnection', () => {
  it("answers the charger's CALLs one at a time, in arrival order", async () => {
    const events: string[] = [];
    let releaseFirst = (): void => undefined;
    const firstMayFinish = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const { connection, socket } = connect(async (call) => {
      events.push(`start ${call.messageId}`);
      if (call.messageId === 'a') await firstMayFinish;
      events.push(`end ${call.messageId}`);
      return { result: {} };
    });

    connection.receive('[2,"a","Heartbeat",{}]');
    connection.receive('[2,"b","Heartbeat",{}]');
    await nextTick();
    expect(events).toEqual(['start a']);

    releaseFirst();
    await vi.waitFor(() => {
      expect(events).toEqual(['start a', 'end a', 'start b', 'end b']);
    });
    expect(socket.sent).toEqual([
      [3, 'a', {}],
      [3, 'b', {}],
    ]);
  });

  it('settles answers to our CALLs at once, even while a charger CALL waits on them', async () => {
    // The handler for the charger's CALL waits for the charger to answer a CALL of ours. If those
    // answers queued behind the charger's CALLs, this would deadlock (D-018).
    const { connection, socket } = connect(async () => ({
      result: await connection.call('GetConfiguration', {}),
    }));

    connection.receive('[2,"c1","Heartbeat",{}]');
    await vi.waitFor(() => {
      expect(socket.sent).toHaveLength(1);
    });
    const [type, ourMessageId, action] = socket.sent[0] as [number, string, string];
    expect([type, action]).toEqual([2, 'GetConfiguration']);

    connection.receive(JSON.stringify([3, ourMessageId, { configurationKey: [] }]));
    await vi.waitFor(() => {
      expect(socket.sent).toHaveLength(2);
    });
    expect(socket.sent[1]).toEqual([3, 'c1', { configurationKey: [] }]);
  });

  it('rejects a CALL the charger answers with a CALLERROR', async () => {
    const { connection, socket } = connect(() => Promise.resolve({ result: {} }));
    const reset = connection.call('Reset', { type: 'Soft' });
    await vi.waitFor(() => {
      expect(socket.sent).toHaveLength(1);
    });
    connection.receive(JSON.stringify([4, socket.sent[0]?.[1], 'NotSupported', 'no', {}]));
    await expect(reset).rejects.toMatchObject({ name: 'OcppCallError', errorCode: 'NotSupported' });
  });

  it('sends one CALL at a time, and gives up on one that gets no answer', async () => {
    vi.useFakeTimers();
    const { connection, socket } = connect(() => Promise.resolve({ result: {} }), 5_000);
    const first = connection.call('GetConfiguration', {});
    const second = connection.call('ClearCache', {});
    const firstFails = expect(first).rejects.toThrow('got no answer within 5000 ms');

    await vi.advanceTimersByTimeAsync(0);
    expect(socket.sent.map((frame) => frame[2])).toEqual(['GetConfiguration']);

    await vi.advanceTimersByTimeAsync(5_000);
    await firstFails;
    expect(socket.sent.map((frame) => frame[2])).toEqual(['GetConfiguration', 'ClearCache']);

    // A late answer to the expired CALL is ignored; the answer to the second one settles it.
    connection.receive(JSON.stringify([3, socket.sent[0]?.[1], {}]));
    connection.receive(JSON.stringify([3, socket.sent[1]?.[1], { status: 'Accepted' }]));
    await expect(second).resolves.toEqual({ status: 'Accepted' });
  });

  it('answers a malformed CALL with FormationViolation, and ignores what it cannot answer', async () => {
    const { connection, socket } = connect(() => Promise.resolve({ result: {} }));
    connection.receive('[2,"m1","Heartbeat"]');
    connection.receive('not json at all');
    connection.receive('[3,"never-sent",{}]');
    await nextTick();
    expect(socket.sent).toEqual([
      [4, 'm1', 'FormationViolation', 'a CALL must be [2, messageId, action, {payload}]', {}],
    ]);
  });

  it('turns a crashed handler into InternalError, and keeps answering', async () => {
    const { connection, socket } = connect((call) =>
      call.messageId === 'boom'
        ? Promise.reject(new Error('database down'))
        : Promise.resolve({ result: { ok: true } }),
    );
    connection.receive('[2,"boom","Heartbeat",{}]');
    connection.receive('[2,"next","Heartbeat",{}]');
    await vi.waitFor(() => {
      expect(socket.sent).toHaveLength(2);
    });
    expect(socket.sent).toEqual([
      [4, 'boom', 'InternalError', 'internal error', {}],
      [3, 'next', { ok: true }],
    ]);
  });

  it('fails CALLs still waiting for an answer when the socket closes', async () => {
    const { connection, socket } = connect(() => Promise.resolve({ result: {} }));
    const pending = connection.call('GetConfiguration', {});
    await vi.waitFor(() => {
      expect(socket.sent).toHaveLength(1);
    });
    connection.closed();
    await expect(pending).rejects.toThrow('connection closed before GetConfiguration was answered');
    await expect(connection.call('ClearCache', {})).rejects.toThrow('connection closed');
  });
});
