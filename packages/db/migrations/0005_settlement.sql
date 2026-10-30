-- 0005_settlement: a stopped session settles once no new evidence has arrived for a while, and
-- evidence that arrives after that changes the bill only through a correction (D-034).

ALTER TABLE transactions
  -- A flag, not a state: a session that needs a person to look at it can be stopped or settled.
  ADD COLUMN needs_review      boolean     NOT NULL DEFAULT false,
  -- When we last received evidence for a stopped session: its stop, or a reading after it.
  ADD COLUMN last_evidence_at  timestamptz,
  ADD COLUMN settled_at        timestamptz,
  -- The bill as it stood when it settled. Never changed afterwards.
  ADD COLUMN settled_energy_wh bigint;

UPDATE transactions SET needs_review = true, state = 'stopped' WHERE state = 'needs_review';
UPDATE transactions SET last_evidence_at = stop_received_at WHERE stopped_at IS NOT NULL;

ALTER TABLE transactions DROP CONSTRAINT transactions_state_check;
ALTER TABLE transactions
  ADD CONSTRAINT transactions_state_check CHECK (state IN ('active', 'stopped', 'settled')),
  ADD CONSTRAINT settled_bill_is_kept
    CHECK ((state = 'settled') = (settled_at IS NOT NULL AND settled_energy_wh IS NOT NULL));

CREATE INDEX transactions_to_settle
  ON transactions (last_evidence_at) WHERE state = 'stopped' AND NOT needs_review;

-- Every change to a settled bill, in order. A settled bill plus its corrections is always the
-- session's current energy_wh.
CREATE TABLE bill_corrections (
  correction_id  bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  transaction_id integer     NOT NULL REFERENCES transactions (transaction_id),
  created_at     timestamptz NOT NULL DEFAULT now(),
  previous_wh    bigint      NOT NULL,
  energy_wh      bigint      NOT NULL,
  delta_wh       bigint      NOT NULL GENERATED ALWAYS AS (energy_wh - previous_wh) STORED,
  CHECK (energy_wh <> previous_wh)
);

CREATE INDEX bill_corrections_by_transaction ON bill_corrections (transaction_id);
