-- 0004: the most power each charger can deliver, so smart charging knows how much a car can use (D-031).
-- NULL means unknown: the controller then never raises the charger above its site's fallback limit.
ALTER TABLE charge_points
  ADD COLUMN max_power_w integer CHECK (max_power_w > 0);
