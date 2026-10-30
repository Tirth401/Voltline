import type { Queryable } from '@voltline/db';

export interface SettleOptions {
  /** How long a stopped session must go without new evidence before its bill is final. */
  quietMs: number;
}

/**
 * Settles every stopped session that has had no new evidence for `quietMs` (D-034). Its bill is
 * kept as settled_energy_wh, and from then on any change to it is a correction. A session that
 * needs review waits for a person.
 *
 * It is one statement, so it is safe to run anywhere, as often as you like, and from several
 * processes at once. A reading that arrives at the same moment holds the session's row lock; this
 * statement then waits for it, and judges the session again as the reading left it.
 */
export async function settleDueSessions(db: Queryable, options: SettleOptions): Promise<number> {
  const result = await db.query(
    `UPDATE transactions
        SET state = 'settled', settled_at = now(), settled_energy_wh = energy_wh
      WHERE state = 'stopped' AND NOT needs_review
        AND last_evidence_at <= now() - $1 * interval '1 millisecond'`,
    [options.quietMs],
  );
  return result.rowCount ?? 0;
}
