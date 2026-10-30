import type { Clock } from '@voltline/common';
import type { Pool } from '@voltline/db';
import type { CommandBus, CommandOutcome, ConnectionRegistry } from '@voltline/routing';
import {
  allocate,
  nextChanges,
  type ConnectorState,
  type LimitChange,
} from '@voltline/smart-charging';
import type { Logger } from 'pino';

export interface ControllerOptions {
  db: Pool;
  bus: Pick<CommandBus, 'send'>;
  registry: Pick<ConnectionRegistry, 'owner'>;
  siteId: string;
  clock: Clock;
  logger: Logger;
  /** How long a limit stays valid on the charger unless refreshed: its validTo. Default 30 s. */
  leaseMs?: number;
  /** Allowance for clocks that disagree a little. Default 2 s. */
  clockSkewMs?: number;
  /**
   * How long a fresh controller sends nothing at all. A controller that ran before it (before a
   * crash or a deploy) may have left chargers on high limits it can't know about, but by then
   * every one of those leases is over. Default: one lease plus the clock allowance.
   */
  startupQuietMs?: number;
  /**
   * Chooses the next changes. Always the cap-safe nextChanges in production; tests swap in a
   * careless one to prove the cap check can catch a controller that breaks the cap.
   */
  planner?: typeof nextChanges;
}

export interface SiteController {
  /**
   * One reconcile pass: read the site and send the next changes. It doesn't wait for the
   * answers. They update what the controller believes when they arrive, so one charger that
   * never answers can't hold up the rest of the site.
   */
  tick(): Promise<{ sent: number; targets: Map<string, number> }>;
}

interface Tracked extends ConnectorState {
  chargePointId: string;
  maxW: number;
  /** When the limit the charger confirmed stops applying on the charger. */
  leaseUntil: number;
  /** When the change in flight would stop applying, had the charger taken it. */
  inFlightUntil?: number;
  /** Which send the change in flight was, so a late answer to an older one is ignored. */
  inFlightId?: number;
}

interface Site {
  capW: number;
  defaultW: number;
  chargers: { id: string; maxW: number }[];
  /** Open transactions, by charger. */
  active: Map<string, number>;
}

/**
 * Keeps one site under its power cap (D-032). Each tick is level-triggered: it reads the site
 * as it is now (chargers, open sessions, who is connected), works out fair targets (D-031), and
 * sends the next safe changes as SetChargingProfile through the command bus (D-030).
 *
 * It keeps one belief per connector: the limit the charger confirmed, plus any change it hasn't
 * heard back about. Every limit carries a lease (validTo). If an answer is lost, the change stays
 * "maybe applied" until its lease would have run out; after that the charger is back on its
 * default whatever happened, so the belief can safely drop to the default too.
 */
export function createController(options: ControllerOptions): SiteController {
  const { db, bus, registry, logger } = options;
  const leaseMs = options.leaseMs ?? 30_000;
  const skewMs = options.clockSkewMs ?? 2_000;
  const planner = options.planner ?? nextChanges;
  const quietUntil = options.clock.now().getTime() + (options.startupQuietMs ?? leaseMs + skewMs);
  const tracked = new Map<string, Tracked>();
  let sends = 0;

  async function loadSite(): Promise<Site> {
    const { rows: sites } = await db.query<{ power_cap_w: number; fallback_limit_w: number }>(
      'SELECT power_cap_w, fallback_limit_w FROM sites WHERE id = $1',
      [options.siteId],
    );
    const site = sites[0];
    if (!site) throw new Error(`no site ${options.siteId}`);
    const { rows: chargers } = await db.query<{ id: string; max_power_w: number | null }>(
      'SELECT id, max_power_w FROM charge_points WHERE site_id = $1 ORDER BY id',
      [options.siteId],
    );
    const { rows: open } = await db.query<{ charge_point_id: string; transaction_id: number }>(
      `SELECT DISTINCT ON (charge_point_id) charge_point_id, transaction_id
         FROM transactions
        WHERE stopped_at IS NULL AND charge_point_id = ANY($1)
        ORDER BY charge_point_id, started_at DESC`,
      [chargers.map((charger) => charger.id)],
    );
    return {
      capW: site.power_cap_w,
      defaultW: site.fallback_limit_w,
      chargers: chargers.map((charger) => ({
        id: charger.id,
        maxW: charger.max_power_w ?? site.fallback_limit_w,
      })),
      active: new Map(open.map((row) => [row.charge_point_id, row.transaction_id])),
    };
  }

  /** Brings our belief about each connector up to date with what we can see now. */
  async function observe(site: Site, now: number): Promise<void> {
    for (const charger of site.chargers) {
      const key = `${charger.id}/1`;
      let connector = tracked.get(key);
      if (!connector) {
        connector = {
          key,
          chargePointId: charger.id,
          defaultW: site.defaultW,
          acknowledgedW: site.defaultW,
          online: false,
          maxW: charger.maxW,
          leaseUntil: 0,
        };
        tracked.set(key, connector);
      }
      connector.defaultW = site.defaultW;
      connector.maxW = charger.maxW;
      connector.online = (await registry.owner(charger.id)) !== undefined;

      if (!site.active.has(charger.id)) {
        // No open transaction: the charger dropped any TxProfile when it ended.
        connector.acknowledgedW = connector.defaultW;
        forgetInFlight(connector);
        connector.leaseUntil = 0;
        continue;
      }
      const leaseOver = now > connector.leaseUntil + skewMs;
      if (connector.inFlightW !== undefined) {
        // An answer we never got: once even that change's lease is over, the charger is on its
        // default whatever it did with it.
        if (leaseOver && now > (connector.inFlightUntil ?? 0) + skewMs) {
          forgetInFlight(connector);
          connector.acknowledgedW = connector.defaultW;
        }
      } else if (leaseOver && connector.acknowledgedW > connector.defaultW) {
        connector.acknowledgedW = connector.defaultW; // not refreshed in time: it fell back
      }
    }
  }

  /** Sends one change. Its answer, whenever it comes, updates what we believe. */
  function send(change: LimitChange, site: Site, now: number): boolean {
    const connector = tracked.get(change.key);
    const transactionId = connector && site.active.get(connector.chargePointId);
    if (!connector || transactionId === undefined) return false;
    const id = ++sends;
    const validTo = now + leaseMs;
    connector.inFlightW = change.limitW;
    connector.inFlightUntil = validTo;
    connector.inFlightId = id;
    bus
      .send(connector.chargePointId, 'SetChargingProfile', {
        connectorId: 1,
        csChargingProfiles: {
          // Same id and stack level each time, so each profile replaces the last one.
          chargingProfileId: 1,
          transactionId,
          stackLevel: 0,
          chargingProfilePurpose: 'TxProfile',
          chargingProfileKind: 'Relative',
          validTo: new Date(validTo).toISOString(),
          chargingSchedule: {
            chargingRateUnit: 'W',
            chargingSchedulePeriod: [{ startPeriod: 0, limit: change.limitW }],
          },
        },
      })
      .then((outcome) => {
        // If we already stopped waiting (its lease would be over, or its session ended), a late
        // answer says nothing about what the charger applies now.
        if (connector.inFlightId === id) learn(connector, change, validTo, outcome);
      })
      .catch((error: unknown) => {
        // Counts as unknown: the change stays in flight until its lease would be over.
        logger.error({ err: error, key: change.key }, 'could not send SetChargingProfile');
      });
    return true;
  }

  function learn(
    connector: Tracked,
    change: LimitChange,
    validTo: number,
    outcome: CommandOutcome,
  ): void {
    switch (outcome.status) {
      case 'answered':
        if (outcome.result['status'] === 'Accepted') {
          connector.acknowledgedW = change.limitW;
          connector.leaseUntil = validTo;
        }
        forgetInFlight(connector); // accepted or refused, we know where it stands
        break;
      case 'invalid':
      case 'not-connected':
      case 'charger-error':
        forgetInFlight(connector); // it never applied this one
        break;
      case 'timeout':
        // Unknown: it may or may not apply it. It stays counted until its lease would be over.
        logger.warn({ key: change.key, limitW: change.limitW }, 'no answer to SetChargingProfile');
        break;
    }
  }

  return {
    async tick() {
      const now = options.clock.now().getTime();
      const site = await loadSite();
      await observe(site, now);
      const connectors = [...tracked.values()];
      const targets = allocate(
        site.capW,
        connectors.map((c) => ({
          key: c.key,
          defaultW: c.defaultW,
          maxW: c.maxW,
          // A car charging wants all it can get; an idle connector wants nothing.
          demandW: site.active.has(c.chargePointId) ? c.maxW : 0,
        })),
      );
      // Just started: we believe every charger is on its default, which may not be true yet.
      if (now < quietUntil) return { sent: 0, targets };
      const changes = planner(site.capW, connectors, targets);
      // Keep confirmed limits alive: refresh a lease once half of it is used up.
      const refreshes = connectors
        .filter(
          (c) =>
            c.online &&
            c.inFlightW === undefined &&
            c.acknowledgedW > c.defaultW &&
            site.active.has(c.chargePointId) &&
            c.leaseUntil - now < leaseMs / 2 &&
            !changes.some((change) => change.key === c.key),
        )
        .map((c) => ({ key: c.key, limitW: c.acknowledgedW }));
      let sent = 0;
      for (const change of [...changes, ...refreshes]) if (send(change, site, now)) sent += 1;
      return { sent, targets };
    },
  };
}

function forgetInFlight(connector: Tracked): void {
  delete connector.inFlightW;
  delete connector.inFlightUntil;
  delete connector.inFlightId;
}
