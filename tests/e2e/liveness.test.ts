import { once } from 'node:events';
import { setTimeout as sleep } from 'node:timers/promises';
import { afterAll, beforeAll, expect, it } from 'vitest';
import WebSocket from 'ws';
import {
  makeChargers,
  registerChargers,
  startStack,
  type ChargerIdentity,
  type Stack,
} from './harness.ts';

const [silent, healthy] = makeChargers(2, 'CP-LIVE') as [ChargerIdentity, ChargerIdentity];
let stack: Stack;

beforeAll(async () => {
  stack = await startStack({ pingIntervalMs: 100 });
  await registerChargers(stack.db.pool, [silent, healthy]);
});

afterAll(async () => {
  await stack.stop();
});

it('drops a connection that stops answering pings (D-026)', async () => {
  const ws = new WebSocket(`${stack.gatewayUrl}/${silent.chargePointId}`, ['ocpp1.6'], {
    autoPong: false,
  });
  await once(ws, 'open');
  const [code] = (await once(ws, 'close')) as [number];
  expect(code).toBe(1006); // terminated, without a closing handshake
});

it('keeps a connection that answers them', async () => {
  const ws = new WebSocket(`${stack.gatewayUrl}/${healthy.chargePointId}`, ['ocpp1.6']);
  await once(ws, 'open');
  await sleep(500); // five ping intervals
  expect(ws.readyState).toBe(WebSocket.OPEN);
  ws.close();
  await once(ws, 'close');
});
