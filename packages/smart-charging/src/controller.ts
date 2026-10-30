/** What the controller knows about one connector's limit. */
export interface ConnectorState {
  key: string;
  /** Its TxDefaultProfile limit: what it falls back to when idle or when a lease runs out. */
  defaultW: number;
  /** The limit the charger last confirmed it applied. */
  acknowledgedW: number;
  /**
   * A limit we sent that the charger hasn't confirmed or refused yet. Until it does, the charger
   * may be applying either this or the acknowledged one, so both count.
   */
  inFlightW?: number;
  /** Whether we can send to it right now. */
  online: boolean;
}

/** A new limit to send to one connector (as a SetChargingProfile). */
export interface LimitChange {
  key: string;
  limitW: number;
}

/**
 * The most this connector might be drawing right now, given everything we know (D-016): the
 * higher of what it confirmed and what we sent but haven't heard back about, and never less than
 * its default, which it can always fall back to.
 */
export function worstCaseW(connector: ConnectorState): number {
  return Math.max(connector.defaultW, connector.acknowledgedW, connector.inFlightW ?? 0);
}

/** The most the whole site might be drawing right now. This must never exceed the cap. */
export function siteWorstCaseW(connectors: readonly ConnectorState[]): number {
  return connectors.reduce((sum, connector) => sum + worstCaseW(connector), 0);
}

/**
 * The next limit changes to send, worked out from the current state alone (D-031, D-033).
 *
 * It is level-triggered: it doesn't care which events led here, so a lost or repeated event can
 * delay convergence but never break the cap. Three rules keep the site under its cap at every
 * moment, not just once everything has settled:
 *
 * 1. Decreases go first: no increase counts on power that a decrease will free until the charger
 *    confirms that decrease.
 * 2. An increase only uses power that is free even if every connector draws its worst case,
 *    counting changes still in flight. A connector with an unconfirmed decrease still counts at
 *    its old, higher limit, and that is what makes rule 1 hold.
 * 3. A connector with a change in flight gets nothing new until the charger answers, so we never
 *    lose track of which limit it might be applying.
 *
 * An unconfirmed decrease doesn't stop other increases. Its answer may be lost, and the whole
 * site would then wait out a lease for nothing (D-033).
 */
export function nextChanges(
  capW: number,
  connectors: readonly ConnectorState[],
  targets: ReadonlyMap<string, number>,
): LimitChange[] {
  const target = (c: ConnectorState): number =>
    Math.max(targets.get(c.key) ?? c.defaultW, c.defaultW);
  const sendable = connectors
    .filter((c) => c.online && c.inFlightW === undefined)
    .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));

  const decreases = sendable
    .filter((c) => target(c) < c.acknowledgedW)
    .map((c) => ({ key: c.key, limitW: target(c) }));

  // Only power that is free right now, with every decrease (sent or about to be) not yet applied.
  let budgetW = capW - siteWorstCaseW(connectors);
  const increases: LimitChange[] = [];
  for (const c of sendable) {
    if (budgetW <= 0) break;
    const raiseW = Math.min(target(c) - c.acknowledgedW, budgetW);
    if (raiseW > 0) {
      increases.push({ key: c.key, limitW: c.acknowledgedW + raiseW });
      budgetW -= raiseW;
    }
  }
  return [...decreases, ...increases];
}
