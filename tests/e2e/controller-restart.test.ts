import { describe, expect, it, vi } from 'vitest';
import { startPowerSite } from './power-harness.ts';

// A restarted controller remembers nothing, but a charger may still hold a high limit the old one
// set (D-032). The script: car A charges alone and gets all the spare power. A's charger drops off
// the network and keeps that limit until its lease runs out. The controller restarts, and car B
// arrives at another charger.

const CAP_W = 30_000;
const DEFAULT_W = 4_140;
/** A's limit while it charges alone: all the spare power. */
const ALONE_W = CAP_W - 2 * DEFAULT_W;
/** A's and B's fair share once both charge. */
const SHARED_W = DEFAULT_W + (CAP_W - 3 * DEFAULT_W) / 2;

async function restartWhileAHoldsItsLimit(startupQuietMs?: number): Promise<number> {
  const site = await startPowerSite({
    seed: 1,
    chargers: 3,
    capW: CAP_W,
    defaultW: DEFAULT_W,
    faults: { rejectProfile: 0, loseAnswer: 0, answerDelayMs: [0, 10] },
  });
  try {
    const [a, b] = site.chargers;
    if (!a || !b) throw new Error('the script needs two chargers');
    const waitForLimit = (key: string, limitW: number) =>
      vi.waitFor(() => expect(site.recorder.current(key)).toBe(limitW), {
        timeout: 5_000,
        interval: 20,
      });

    site.startController();
    await a.startSession();
    await waitForLimit(a.key, ALONE_W);
    await a.disconnect(); // A keeps ALONE_W until its lease runs out
    site.startController(startupQuietMs === undefined ? {} : { startupQuietMs });
    await b.startSession();
    await waitForLimit(b.key, SHARED_W);
    return site.recorder.peakTotalW();
  } finally {
    await site.close();
  }
}

describe('a controller restart (D-032)', () => {
  it('waits until the old leases are over, so the site stays under its cap', async () => {
    expect(await restartWhileAHoldsItsLimit()).toBeLessThanOrEqual(CAP_W);
  });

  it('would break the cap if a fresh controller trusted its empty memory', async () => {
    // It believes A is on its default and gives B a share at once: A's old limit, B's new one
    // and the idle charger's default, all at the same time.
    expect(await restartWhileAHoldsItsLimit(0)).toBe(ALONE_W + SHARED_W + DEFAULT_W);
  });
});
