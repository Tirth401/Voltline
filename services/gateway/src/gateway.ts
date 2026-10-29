import { createServer, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Duplex } from 'node:stream';
import type { AvailabilityStore } from '@voltline/availability';
import { systemClock, type Clock } from '@voltline/common';
import type { Pool } from '@voltline/db';
import type { V16Validator } from '@voltline/ocpp';
import type { Logger } from 'pino';
import { WebSocketServer, type RawData, type WebSocket } from 'ws';
import { ChargerConnection } from './connection.ts';
import { createDispatcher } from './handlers.ts';

export interface GatewayOptions {
  db: Pool;
  availability: AvailabilityStore;
  validator: V16Validator;
  logger: Logger;
  clock?: Clock;
  /** Told to chargers in BootNotification.conf: how often to send a Heartbeat. Default 300 s. */
  heartbeatIntervalSec?: number;
  /** How long to wait for a charger to answer a CALL we send. Default 30 s. */
  callTimeoutMs?: number;
  /** Also check our own responses against the schemas. On in tests; costs a little CPU. */
  validateResponses?: boolean;
}

export interface Gateway {
  listen(port: number, host?: string): Promise<AddressInfo>;
  close(): Promise<void>;
  /** Live connections, by charger identity. */
  readonly connections: ReadonlyMap<string, ChargerConnection>;
}

const SUBPROTOCOL = 'ocpp1.6';
const OCPP_PATH = /^\/ocpp\/([^/]+)$/;
// Identities end up in Redis keys and log lines, so keep them to a safe, printable set.
const CHARGE_POINT_ID = /^[A-Za-z0-9._:-]{1,48}$/;
// OCPP messages are small. The cap stops one misbehaving client from exhausting memory.
const MAX_FRAME_BYTES = 1024 * 1024;

/**
 * The OCPP 1.6J gateway: chargers connect to ws://host/ocpp/{chargePointId} offering the
 * `ocpp1.6` subprotocol, and each gets one ChargerConnection.
 */
export function createGateway(options: GatewayOptions): Gateway {
  const log = options.logger;
  const callTimeoutMs = options.callTimeoutMs ?? 30_000;
  const connections = new Map<string, ChargerConnection>();
  const dispatch = createDispatcher({
    db: options.db,
    availability: options.availability,
    clock: options.clock ?? systemClock,
    heartbeatIntervalSec: options.heartbeatIntervalSec ?? 300,
    validator: options.validator,
    validateResponses: options.validateResponses ?? false,
  });

  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: MAX_FRAME_BYTES,
    handleProtocols: (protocols) => (protocols.has(SUBPROTOCOL) ? SUBPROTOCOL : false),
  });

  const server = createServer((request, response) => {
    if (request.url === '/healthz') {
      response.writeHead(200, { 'Content-Type': 'text/plain' }).end('ok\n');
      return;
    }
    response
      .writeHead(426, { 'Content-Type': 'text/plain', Upgrade: 'websocket' })
      .end('Chargers connect with a WebSocket upgrade to /ocpp/{chargePointId}\n');
  });

  server.on('upgrade', (request: IncomingMessage, socket: Duplex, head: Buffer) => {
    acceptCharger(request, socket, head).catch((error: unknown) => {
      log.error({ err: error }, 'WebSocket upgrade failed');
      refuse(socket, 500, 'Internal Server Error');
    });
  });

  async function acceptCharger(request: IncomingMessage, socket: Duplex, head: Buffer) {
    const match = OCPP_PATH.exec(new URL(request.url ?? '/', 'http://gateway').pathname);
    const chargePointId = match?.[1] === undefined ? undefined : decodePathSegment(match[1]);
    if (chargePointId === undefined || !CHARGE_POINT_ID.test(chargePointId)) {
      refuse(socket, 404, 'Not Found');
      return;
    }
    const offered = (request.headers['sec-websocket-protocol'] ?? '').split(',');
    if (!offered.map((protocol) => protocol.trim()).includes(SUBPROTOCOL)) {
      refuse(socket, 400, 'Bad Request');
      return;
    }
    // Only registered chargers may connect (D-017).
    const known = await options.db.query('SELECT 1 FROM charge_points WHERE id = $1', [
      chargePointId,
    ]);
    if (known.rowCount === 0) {
      log.warn({ chargePointId }, 'refused an unregistered charger');
      refuse(socket, 404, 'Not Found');
      return;
    }
    wss.handleUpgrade(request, socket, head, (ws) => {
      attach(ws, chargePointId);
    });
  }

  function attach(ws: WebSocket, chargePointId: string): void {
    const connectionLog = log.child({ chargePointId });
    // A charger that reconnects has given up on its old socket, so the newest connection wins.
    connections.get(chargePointId)?.close(1000, 'replaced by a newer connection');

    const connection = new ChargerConnection({
      chargePointId,
      socket: ws,
      logger: connectionLog,
      callTimeoutMs,
      answer: (call) => dispatch(chargePointId, call, connectionLog),
    });
    connections.set(chargePointId, connection);

    ws.on('message', (data: RawData, isBinary: boolean) => {
      if (isBinary) {
        connectionLog.warn('ignored a binary frame: OCPP-J only uses text');
        return;
      }
      connection.receive(rawDataToText(data));
    });
    ws.on('close', (code: number) => {
      connection.closed();
      if (connections.get(chargePointId) === connection) connections.delete(chargePointId);
      connectionLog.info({ code }, 'disconnected');
    });
    ws.on('error', (error: Error) => {
      connectionLog.warn({ err: error }, 'socket error');
    });
    connectionLog.info('connected');
  }

  return {
    connections,
    listen: (port, host) =>
      new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, host, () => {
          server.off('error', reject);
          resolve(server.address() as AddressInfo);
        });
      }),
    close: async () => {
      for (const connection of connections.values()) {
        connection.close(1001, 'gateway shutting down');
      }
      wss.close();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    },
  };
}

function refuse(socket: Duplex, status: number, reason: string): void {
  socket.end(`HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
}

function decodePathSegment(segment: string): string | undefined {
  try {
    return decodeURIComponent(segment);
  } catch {
    return undefined; // malformed %-escape
  }
}

function rawDataToText(data: RawData): string {
  if (Array.isArray(data)) return Buffer.concat(data).toString('utf8');
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString('utf8');
  return data.toString('utf8');
}
