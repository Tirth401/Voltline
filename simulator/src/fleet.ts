import { Prng } from '@voltline/common';
import type { V16Validator } from '@voltline/ocpp';
import { SimulatedCharger, type SessionTruth } from './charger.ts';
import type { FaultProfile } from './faults.ts';

export interface FleetOptions {
  gatewayUrl: string | readonly string[];
  chargers: readonly { chargePointId: string; idTag: string }[];
  /** Total sessions, spread as evenly as possible across the chargers. */
  sessions: number;
  seed: number;
  faults: FaultProfile;
  validator?: V16Validator;
  startTime?: Date;
}

export interface FleetResult {
  sessions: SessionTruth[];
  /** Chargers that crashed before finishing: always a bug, in the simulator or the gateway. */
  failures: { chargePointId: string; error: unknown }[];
}

/**
 * Runs many chargers at once, each through its own sessions. Each charger draws from a stream
 * forked off the seed by its identity, so a seed reproduces every charger's choices, whatever
 * order the network interleaves them in (D-011).
 */
export async function runFleet(options: FleetOptions): Promise<FleetResult> {
  const root = new Prng(options.seed);
  const { chargers } = options;
  const base = Math.floor(options.sessions / chargers.length);
  const extra = options.sessions % chargers.length;

  const settled = await Promise.allSettled(
    chargers.map((charger, i) =>
      new SimulatedCharger({
        gatewayUrl: options.gatewayUrl,
        chargePointId: charger.chargePointId,
        idTag: charger.idTag,
        rng: root.fork(charger.chargePointId),
        faults: options.faults,
        ...(options.validator && { validator: options.validator }),
        ...(options.startTime && { startTime: options.startTime }),
      }).run(base + (i < extra ? 1 : 0)),
    ),
  );

  const result: FleetResult = { sessions: [], failures: [] };
  settled.forEach((outcome, i) => {
    if (outcome.status === 'fulfilled') result.sessions.push(...outcome.value);
    else
      result.failures.push({
        chargePointId: chargers[i]?.chargePointId ?? '?',
        error: outcome.reason,
      });
  });
  return result;
}
