-- 0003: lets a charger's frames be replayed in exactly the order its gateway connection saw them (D-023).
-- Timestamps alone can tie; (connection_id, seq) can't.
ALTER TABLE ocpp_frames
  ADD COLUMN connection_id text,
  ADD COLUMN seq integer;
