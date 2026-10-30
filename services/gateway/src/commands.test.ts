import { createV16Validator } from '@voltline/ocpp';
import { pino } from 'pino';
import { describe, expect, it, vi } from 'vitest';
import { runCommand } from './commands.ts';
import { ChargerConnection, type FrameSocket } from './connection.ts';

/** Records what the connection sends, already parsed. */
class FakeSocket implements FrameSocket {
  readonly sent: unknown[][] = [];
  send(data: string): void {
    this.sent.push(JSON.parse(data) as unknown[]);
  }
  close(): void {}
}

const validator = createV16Validator();
const TRIGGER = {
  chargePointId: 'CP-1',
  action: 'TriggerMessage',
  payload: { requestedMessage: 'Heartbeat' },
};

function connect(callTimeoutMs = 1_000) {
  const socket = new FakeSocket();
  const connection = new ChargerConnection({
    chargePointId: 'CP-1',
    socket,
    logger: pino({ level: 'silent' }),
    callTimeoutMs,
    answer: () => Promise.resolve({ result: {} }),
  });
  return { connection, socket };
}

/** The message id of the CALL the connection just sent. */
async function sentCall(socket: FakeSocket): Promise<string> {
  await vi.waitFor(() => {
    expect(socket.sent).toHaveLength(1);
  });
  return String(socket.sent[0]?.[1]);
}

describe('runCommand', () => {
  it("brings back the charger's answer, checked against the schema", async () => {
    const { connection, socket } = connect();
    const outcome = runCommand(connection, TRIGGER, validator);
    connection.receive(JSON.stringify([3, await sentCall(socket), { status: 'Accepted' }]));
    expect(await outcome).toEqual({ status: 'answered', result: { status: 'Accepted' } });
  });

  it('reports "not connected" when the command never went out', async () => {
    expect(await runCommand(undefined, TRIGGER, validator)).toEqual({ status: 'not-connected' });
    const { connection } = connect();
    connection.closed();
    expect(await runCommand(connection, TRIGGER, validator)).toEqual({ status: 'not-connected' });
  });

  // The charger may have acted on it before its socket died, so this must never look like
  // "not connected": the charging controller would think the limit was never applied (D-032).
  it('reports "unknown" when the connection closes after the command went out', async () => {
    const { connection, socket } = connect();
    const outcome = runCommand(connection, TRIGGER, validator);
    await sentCall(socket);
    connection.closed();
    expect(await outcome).toEqual({ status: 'timeout' });
  });

  it('reports "unknown" when no answer comes in time', async () => {
    const { connection, socket } = connect(20);
    const outcome = runCommand(connection, TRIGGER, validator);
    await sentCall(socket);
    expect(await outcome).toEqual({ status: 'timeout' });
  });

  it('refuses what the CSMS may not send, and payloads that break the schema', async () => {
    const { connection, socket } = connect();
    const notOurs = await runCommand(
      connection,
      { ...TRIGGER, action: 'Authorize', payload: { idTag: 'X' } },
      validator,
    );
    const broken = await runCommand(connection, { ...TRIGGER, payload: {} }, validator);
    expect([notOurs.status, broken.status]).toEqual(['invalid', 'invalid']);
    expect(socket.sent).toEqual([]);
  });
});
