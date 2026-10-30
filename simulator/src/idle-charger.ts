import { setTimeout as sleep } from 'node:timers/promises';
import type { Prng } from '@voltline/common';
import type { V16Validator } from '@voltline/ocpp';
import { OcppClient } from './ocpp-client.ts';

// The same backoff as the session chargers: exponential, with full jitter (D-028).
const BASE_BACKOFF_MS = 50;
const MAX_BACKOFF_MS = 2_000;

export interface IdleChargerOptions {
  /** Gateway base URLs. Each connection attempt picks one at random, as a load balancer would. */
  gatewayUrls: readonly string[];
  chargePointId: string;
  /** Its own random stream: which gateway to try, and how long to back off. */
  rng: Prng;
  validator?: V16Validator;
  /** How long to keep trying to connect before giving up. Default 120 s. */
  giveUpMs?: number;
  /** false waits the full backoff every time: the baseline that shows what jitter buys. */
  jitter?: boolean;
}

/** One time the charger lost its connection, and how it got back. Times are performance.now(). */
export interface Reconnect {
  lostAt: number;
  /**
   * The WebSocket close code: 1006 if the connection simply broke (the gateway crashed), 1001 if
   * the gateway was shutting down, 1013 if it moved the charger to rebalance (D-039).
   */
  closeCode: number;
  /** When a gateway accepted its BootNotification again; undefined while trying, or if it gave up. */
  bootedAt: number | undefined;
  attempts: number;
  /** BootNotifications answered Pending on the way back: the gateways asked it to wait. */
  pendingBoots: number;
  gaveUp: boolean;
}

/**
 * A charger with no car: it connects, boots, reports its connector Available, and stays
 * connected. When the connection drops, it reconnects to any gateway with exponential backoff and
 * full jitter, and records how long that took, measured from its own side. A car park full of
 * these is what a gateway restart hits (result 3).
 */
export class IdleCharger {
  readonly chargePointId: string;
  readonly reconnects: Reconnect[] = [];
  /** How long its very first connection and BootNotification took, in ms. */
  firstBootMs: number | undefined;
  /** BootNotifications answered Pending before its very first one was accepted. */
  firstPendingBoots = 0;
  /** WebSocket connections it has opened so far, accepted or not. */
  socketsOpened = 0;
  readonly #options: IdleChargerOptions;
  #client: OcppClient | undefined;
  #stopped = false;

  constructor(options: IdleChargerOptions) {
    this.#options = options;
    this.chargePointId = options.chargePointId;
  }

  /** Connected, and accepted by a gateway. */
  get connected(): boolean {
    return this.#client !== undefined;
  }

  /** Connects and boots for the first time; resolves once a gateway has accepted it. */
  async start(): Promise<void> {
    const startedAt = performance.now();
    const { ok, pendingBoots } = await this.#connectWithRetries(startedAt);
    this.firstPendingBoots = pendingBoots;
    if (!ok) throw new Error(`${this.chargePointId} could not connect to any gateway`);
    this.firstBootMs = performance.now() - startedAt;
  }

  async stop(): Promise<void> {
    this.#stopped = true;
    const client = this.#client;
    this.#client = undefined;
    await client?.close();
  }

  async #connectWithRetries(
    since: number,
  ): Promise<{ ok: boolean; attempts: number; pendingBoots: number }> {
    const giveUpMs = this.#options.giveUpMs ?? 120_000;
    let attempts = 0;
    const pending = { boots: 0 };
    while (!this.#stopped) {
      attempts += 1;
      try {
        await this.#connectOnce(pending);
        return { ok: true, attempts, pendingBoots: pending.boots };
      } catch {
        if (performance.now() - since > giveUpMs) break;
        const ceiling = Math.min(MAX_BACKOFF_MS, BASE_BACKOFF_MS * 2 ** Math.min(attempts, 10));
        await sleep(this.#options.jitter === false ? ceiling : this.#options.rng.int(0, ceiling));
      }
    }
    return { ok: false, attempts, pendingBoots: pending.boots };
  }

  async #connectOnce(pending: { boots: number }): Promise<void> {
    const url = this.#options.rng.pick(this.#options.gatewayUrls);
    let client: OcppClient | undefined = undefined;
    this.socketsOpened += 1;
    client = await OcppClient.connect(`${url}/${encodeURIComponent(this.chargePointId)}`, {
      ...(this.#options.validator && { validator: this.#options.validator }),
      onClose: (code) => {
        if (client !== undefined && client === this.#client) this.#lost(code);
      },
    });
    try {
      for (;;) {
        const boot = await client.call('BootNotification', {
          chargePointVendor: 'Voltline',
          chargePointModel: 'IdleSim',
        });
        if (boot.status === 'Accepted') break;
        // Pending or Rejected: OCPP 1.6 says to try again after the interval it was given, on the
        // same connection.
        pending.boots += 1;
        await sleep(Math.max(1, boot.interval) * 1_000);
      }
      await client.call('StatusNotification', {
        connectorId: 1,
        errorCode: 'NoError',
        status: 'Available',
        timestamp: new Date().toISOString(),
      });
    } catch (error) {
      await client.close();
      throw error;
    }
    if (this.#stopped) {
      await client.close();
      return;
    }
    this.#client = client;
  }

  #lost(closeCode: number): void {
    this.#client = undefined;
    if (this.#stopped) return;
    const reconnect: Reconnect = {
      lostAt: performance.now(),
      closeCode,
      bootedAt: undefined,
      attempts: 0,
      pendingBoots: 0,
      gaveUp: false,
    };
    this.reconnects.push(reconnect);
    void this.#connectWithRetries(reconnect.lostAt).then(({ ok, attempts, pendingBoots }) => {
      reconnect.attempts = attempts;
      reconnect.pendingBoots = pendingBoots;
      if (ok) reconnect.bootedAt = performance.now();
      else reconnect.gaveUp = !this.#stopped;
    });
  }
}
