-- 0002: OCPP id tags are case-insensitive (IdToken is a CiString), so "abc" and "ABC" are one tag (D-020).
CREATE UNIQUE INDEX id_tags_case_insensitive ON id_tags (lower(id_tag));

-- Finds a tag's open session quickly, for the ConcurrentTx check in Authorize and StartTransaction.
CREATE INDEX transactions_open_by_id_tag ON transactions (lower(id_tag)) WHERE stopped_at IS NULL;
