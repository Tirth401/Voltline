-- 0001_init: sites, chargers, id tags, sessions (OCPP transactions), meter readings, raw frames.
-- The reasoning behind each choice is in DECISIONS.md; entry numbers are referenced inline.

CREATE EXTENSION IF NOT EXISTS timescaledb;

CREATE TABLE sites (
  id               text    PRIMARY KEY,
  name             text    NOT NULL,
  power_cap_w      integer NOT NULL CHECK (power_cap_w > 0),
  -- What each connector may draw when it has no allocation or its charger is offline (D-016).
  fallback_limit_w integer NOT NULL CHECK (fallback_limit_w >= 0)
);

CREATE TABLE charge_points (
  id               text        PRIMARY KEY,  -- OCPP identity: the last segment of the WebSocket URL
  site_id          text        REFERENCES sites (id),
  vendor           text,
  model            text,
  serial_number    text,
  firmware_version text,
  last_boot_at     timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE id_tags (
  id_tag        text        PRIMARY KEY CHECK (char_length(id_tag) <= 20),  -- IdToken is CiString20Type
  status        text        NOT NULL DEFAULT 'Accepted'
                            CHECK (status IN ('Accepted', 'Blocked', 'Expired', 'Invalid')),
  expires_at    timestamptz,
  parent_id_tag text
);

-- One row per OCPP 1.6 transaction. Start and stop evidence are written once; energy is derived (D-009).
-- id_tag has no foreign key on purpose: a session with an unknown tag is still recorded (D-008).
CREATE TABLE transactions (
  transaction_id    integer     GENERATED ALWAYS AS IDENTITY PRIMARY KEY,  -- int32 (D-007)
  charge_point_id   text        NOT NULL REFERENCES charge_points (id),
  connector_id      integer     NOT NULL CHECK (connector_id > 0),
  id_tag            text        NOT NULL,
  auth_status       text        NOT NULL,  -- the idTagInfo.status we answered, returned again on retries
  started_at        timestamptz NOT NULL,  -- the charger's timestamp, never server time
  meter_start_wh    bigint      NOT NULL CHECK (meter_start_wh >= 0),
  start_received_at timestamptz NOT NULL DEFAULT now(),
  stopped_at        timestamptz,
  meter_stop_wh     bigint      CHECK (meter_stop_wh >= 0),
  stop_reason       text,
  stop_received_at  timestamptz,
  state             text        NOT NULL DEFAULT 'active'
                                CHECK (state IN ('active', 'stopped', 'settled', 'needs_review')),
  energy_wh         bigint,                -- recomputed from evidence under a row lock
  resets_detected   integer     NOT NULL DEFAULT 0,
  CONSTRAINT start_idempotency
    UNIQUE (charge_point_id, connector_id, started_at, meter_start_wh)  -- D-006
);

CREATE INDEX transactions_open_by_connector
  ON transactions (charge_point_id, connector_id) WHERE stopped_at IS NULL;

-- Every sampled value, from MeterValues.req and from StopTransaction.req's transactionData.
-- No foreign keys: evidence is never rejected, and a reading for an unknown transaction is kept (D-008).
CREATE TABLE meter_readings (
  charge_point_id text        NOT NULL,
  connector_id    integer     NOT NULL CHECK (connector_id >= 0),  -- 0 = the charger's main meter
  transaction_id  integer,                                          -- optional in MeterValues.req
  ts              timestamptz NOT NULL,                             -- the charger's sample time
  measurand       text        NOT NULL DEFAULT 'Energy.Active.Import.Register',
  phase           text        NOT NULL DEFAULT '',                  -- '' not NULL, so the key dedups (D-013)
  location        text        NOT NULL DEFAULT 'Outlet',
  context         text        NOT NULL DEFAULT 'Sample.Periodic',
  unit            text        NOT NULL DEFAULT 'Wh',
  raw_value       text        NOT NULL,                             -- exactly what the charger sent
  value_wh        bigint,                                           -- energy only, parsed exactly (D-007)
  received_at     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT one_value_per_instant
    UNIQUE (charge_point_id, connector_id, measurand, phase, location, ts)  -- D-013
);

SELECT create_hypertable('meter_readings', by_range('ts', INTERVAL '1 day'));

CREATE INDEX meter_readings_by_transaction
  ON meter_readings (transaction_id, ts) WHERE transaction_id IS NOT NULL;

-- Every OCPP-J frame in and out, exactly as sent, for debugging and trace replay (D-011).
-- message_type and message_id are NULL when a frame couldn't be parsed.
CREATE TABLE ocpp_frames (
  charge_point_id text        NOT NULL,
  at              timestamptz NOT NULL DEFAULT now(),
  direction       text        NOT NULL CHECK (direction IN ('in', 'out')),
  message_type    smallint    CHECK (message_type IN (2, 3, 4)),  -- CALL, CALLRESULT, CALLERROR
  message_id      text,
  action          text,                                            -- set on CALLs only
  raw             text        NOT NULL
);

SELECT create_hypertable('ocpp_frames', by_range('at', INTERVAL '1 day'));

CREATE INDEX ocpp_frames_by_charger ON ocpp_frames (charge_point_id, at);
