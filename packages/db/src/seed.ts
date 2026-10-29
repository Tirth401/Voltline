import type { Queryable } from './pool.ts';

/** Demo data for running the gateway and simulator by hand. */
export const DEMO = {
  siteId: 'SITE-DEMO',
  chargePointIds: ['CP-DEMO-1', 'CP-DEMO-2'],
  idTag: 'TAG-DEMO-1',
} as const;

/** Inserts the demo site, chargers and id tag. Safe to run repeatedly (pnpm db:seed). */
export async function seedDemo(db: Queryable): Promise<void> {
  // 100 kW site; the fallback is 6 A on three phases at 230 V = 4,140 W per connector.
  await db.query(
    `INSERT INTO sites (id, name, power_cap_w, fallback_limit_w)
     VALUES ($1, 'Demo site', 100000, 4140) ON CONFLICT (id) DO NOTHING`,
    [DEMO.siteId],
  );
  for (const chargePointId of DEMO.chargePointIds) {
    await db.query(
      `INSERT INTO charge_points (id, site_id) VALUES ($1, $2) ON CONFLICT (id) DO NOTHING`,
      [chargePointId, DEMO.siteId],
    );
  }
  await db.query(`INSERT INTO id_tags (id_tag) VALUES ($1) ON CONFLICT DO NOTHING`, [DEMO.idTag]);
}
