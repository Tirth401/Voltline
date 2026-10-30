import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { AvailabilityStore } from '@voltline/availability';
import type { Pool } from '@voltline/db';
import type { CommandBus, CommandOutcome, ConnectionRegistry } from '@voltline/routing';
import type { Logger } from 'pino';

export interface ApiOptions {
  db: Pool;
  availability: AvailabilityStore;
  registry: ConnectionRegistry;
  bus: CommandBus;
  logger: Logger;
}

export interface Api {
  listen(port: number, host?: string): Promise<AddressInfo>;
  close(): Promise<void>;
}

interface Reply {
  status: number;
  body: unknown;
}

type Route = [
  method: string,
  path: RegExp,
  handle: (params: string[], request: IncomingMessage) => Promise<Reply>,
];

class HttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

const MAX_BODY_BYTES = 64 * 1024;

/** Charging limits belong to the charging controller: one set by hand would be invisible to it. */
const CONTROLLER_ONLY = new Set(['SetChargingProfile', 'ClearChargingProfile']);

const COMMAND_STATUS: Record<CommandOutcome['status'], number> = {
  answered: 200,
  invalid: 400,
  'charger-error': 502,
  'not-connected': 409,
  timeout: 504,
};

/**
 * The REST API: live connector status, sessions and their bills, and commands to chargers. It
 * keeps no state of its own, so any number can run; a command reaches its charger through
 * whichever gateway holds the socket (D-030).
 */
export function createApi(options: ApiOptions): Api {
  const { db, availability, registry, bus, logger } = options;

  const routes: Route[] = [
    ['GET', /^\/healthz$/, () => Promise.resolve({ status: 200, body: { ok: true } })],

    [
      'GET',
      /^\/chargers\/([^/]+)$/,
      async ([chargePointId = '']) => {
        const { rows } = await db.query<{
          vendor: string | null;
          model: string | null;
          firmware_version: string | null;
          last_boot_at: Date | null;
        }>(
          'SELECT vendor, model, firmware_version, last_boot_at FROM charge_points WHERE id = $1',
          [chargePointId],
        );
        const charger = rows[0];
        if (!charger) throw new HttpError(404, `no charger ${chargePointId}`);
        const [owner, connectors] = await Promise.all([
          registry.owner(chargePointId),
          availability.connectors(chargePointId),
        ]);
        return {
          status: 200,
          body: {
            chargePointId,
            vendor: charger.vendor,
            model: charger.model,
            firmwareVersion: charger.firmware_version,
            lastBootAt: charger.last_boot_at,
            connection: owner ? { gatewayId: owner.gatewayId, epoch: owner.epoch } : null,
            connectors: connectors.map(({ connectorId, status, errorCode, timestamp }) => ({
              connectorId,
              status,
              errorCode,
              since: timestamp,
            })),
          },
        };
      },
    ],

    [
      'GET',
      /^\/chargers\/([^/]+)\/sessions$/,
      async ([chargePointId = '']) => {
        const { rows } = await db.query<SessionRow>(
          `${SESSION_COLUMNS} WHERE charge_point_id = $1 ORDER BY started_at DESC LIMIT 50`,
          [chargePointId],
        );
        return { status: 200, body: rows.map(toSession) };
      },
    ],

    [
      'GET',
      /^\/sessions\/(\d+)$/,
      async ([transactionId = '']) => {
        const { rows } = await db.query<SessionRow>(
          `${SESSION_COLUMNS} WHERE transaction_id = $1`,
          [Number(transactionId)],
        );
        const session = rows[0];
        if (!session) throw new HttpError(404, `no session ${transactionId}`);
        // Changes to the bill after it settled, oldest first (D-034).
        const { rows: corrections } = await db.query<{
          created_at: Date;
          previous_wh: number;
          energy_wh: number;
          delta_wh: number;
        }>(
          `SELECT created_at, previous_wh, energy_wh, delta_wh
             FROM bill_corrections WHERE transaction_id = $1 ORDER BY correction_id`,
          [session.transaction_id],
        );
        return {
          status: 200,
          body: {
            ...toSession(session),
            corrections: corrections.map((correction) => ({
              at: correction.created_at,
              previousWh: correction.previous_wh,
              energyWh: correction.energy_wh,
              deltaWh: correction.delta_wh,
            })),
          },
        };
      },
    ],

    [
      'POST',
      /^\/chargers\/([^/]+)\/commands\/([A-Za-z]+)$/,
      async ([chargePointId = '', action = ''], request) => {
        if (CONTROLLER_ONLY.has(action)) {
          throw new HttpError(403, `${action} is sent only by the charging controller (D-032)`);
        }
        const payload = await readJsonObject(request);
        const outcome = await bus.send(chargePointId, action, payload);
        return { status: COMMAND_STATUS[outcome.status], body: outcome };
      },
    ],
  ];

  const server = createServer((request, response) => {
    void respond(request, response);
  });

  async function respond(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const path = new URL(request.url ?? '/', 'http://api').pathname;
    let reply: Reply;
    try {
      reply = await route(request.method ?? 'GET', path, request);
    } catch (error) {
      if (error instanceof HttpError) {
        reply = { status: error.status, body: { error: error.message } };
      } else {
        logger.error({ err: error, path }, 'request failed');
        reply = { status: 500, body: { error: 'internal error' } };
      }
    }
    response
      .writeHead(reply.status, { 'Content-Type': 'application/json' })
      .end(`${JSON.stringify(reply.body)}\n`);
  }

  async function route(method: string, path: string, request: IncomingMessage): Promise<Reply> {
    let pathMatched = false;
    for (const [routeMethod, pattern, handle] of routes) {
      const match = pattern.exec(path);
      if (!match) continue;
      pathMatched = true;
      if (routeMethod === method) {
        return handle(match.slice(1).map(decodeURIComponent), request);
      }
    }
    throw pathMatched ? new HttpError(405, 'method not allowed') : new HttpError(404, 'not found');
  }

  return {
    listen: (port, host) =>
      new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, host, () => {
          server.off('error', reject);
          resolve(server.address() as AddressInfo);
        });
      }),
    close: () =>
      new Promise((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}

const SESSION_COLUMNS = `
  SELECT transaction_id, charge_point_id, connector_id, id_tag, auth_status, started_at,
         stopped_at, meter_start_wh, meter_stop_wh, energy_wh, resets_detected, state, stop_reason,
         needs_review, settled_at, settled_energy_wh
    FROM transactions`;

interface SessionRow {
  transaction_id: number;
  charge_point_id: string;
  connector_id: number;
  id_tag: string;
  auth_status: string;
  started_at: Date;
  stopped_at: Date | null;
  meter_start_wh: number;
  meter_stop_wh: number | null;
  energy_wh: number | null;
  resets_detected: number;
  state: string;
  stop_reason: string | null;
  needs_review: boolean;
  settled_at: Date | null;
  settled_energy_wh: number | null;
}

function toSession(row: SessionRow) {
  return {
    transactionId: row.transaction_id,
    chargePointId: row.charge_point_id,
    connectorId: row.connector_id,
    idTag: row.id_tag,
    authStatus: row.auth_status,
    startedAt: row.started_at,
    stoppedAt: row.stopped_at,
    meterStartWh: row.meter_start_wh,
    meterStopWh: row.meter_stop_wh,
    energyWh: row.energy_wh,
    resetsDetected: row.resets_detected,
    state: row.state,
    stopReason: row.stop_reason,
    needsReview: row.needs_review,
    settledAt: row.settled_at,
    /** The bill when it settled; energyWh is this plus any corrections since (D-034). */
    settledEnergyWh: row.settled_energy_wh,
  };
}

async function readJsonObject(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new HttpError(413, 'request body too large');
    chunks.push(chunk);
  }
  const text = Buffer.concat(chunks).toString('utf8').trim();
  if (text === '') return {};
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    throw new HttpError(400, 'request body is not valid JSON');
  }
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new HttpError(400, 'request body must be a JSON object');
  }
  return body as Record<string, unknown>;
}
