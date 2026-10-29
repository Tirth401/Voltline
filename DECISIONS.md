# Design decisions

Each entry says what we decided, why, and what we rejected. When a decision changes, add a new
entry that supersedes the old one rather than editing history. Code and SQL comments point here by
number, e.g. `(D-006)`.

---

## D-001 · OCPP 1.6J only; 2.0.1 is a stretch goal

_2026-10-29_

**Decision.** Implement OCPP 1.6J. Keep the protocol layer version-aware (WebSocket subprotocol
negotiation, one schema folder per version), but don't build 2.0.1 this semester.

**Why.** 2.0.1 isn't an extension of 1.6. Transactions become TransactionEvent, the charger
assigns transaction ids, and there's a whole device model. Doing both would halve the depth of
everything else.

## D-002 · One repo, pnpm workspaces, no build orchestrator

_2026-10-29_

**Decision.** A pnpm workspace: libraries in `packages/`, deployables in `services/`.

**Why.** pnpm's strict `node_modules` fails fast when code imports a package it never declared.
Ten or so small packages don't need Turborepo or Nx.

## D-003 · TypeScript runs directly on Node 24; no build step in development

_2026-10-29_

**Decision.** Node 24 strips TypeScript types when it loads a file, so `node file.ts` just works.
Packages export their `.ts` source, and nothing is compiled ahead of time. `tsc` only type-checks.

**Why.** One less tool between what we wrote and what runs. Checked on this setup: `.ts` files
load without warnings, including through the symlinks pnpm uses between workspace packages.

**Cost.** Only syntax Node can erase: no `enum`, `namespace`, or constructor parameter
properties, and relative imports end in `.ts`. `erasableSyntaxOnly` in `tsconfig.json` enforces it.

**Rejected.** `tsx`/`ts-node` in development plus a `tsc` build: more moving parts, no benefit here.

## D-004 · TypeScript is pinned to 6.0.x, not 7

_2026-10-29_

**Decision.** `typescript@6.0.3`.

**Why.** `typescript-eslint@8.72.1` supports TypeScript `>=4.8.4 <6.1.0`. Its type-aware rules,
especially `no-floating-promises` (D-005), are worth more to this project than TypeScript 7's
faster compiler. Revisit when typescript-eslint supports 7.

## D-005 · Billing runs inside the gateway; persist, then acknowledge

_2026-10-29_

**Decision.** Billing is a library the gateway calls in-process. A handler commits the evidence
to Postgres before the CALLRESULT goes out.

**Why.** If the gateway dies after the commit but before the ack, the charger retries and the
duplicate keys (D-006, D-013) absorb the retry. If it dies before the commit, nothing was
acknowledged, so the charger still has the message. Either way nothing is lost or counted twice.
A separate billing service would put a network hop between commit and ack: one more way to fail,
and no help with any of our three targets.

**Enforced by.** `@typescript-eslint/no-floating-promises`. An un-awaited promise is exactly how
an ack escapes before its commit.

## D-006 · StartTransaction is deduplicated on (charger, connector, start time, start meter reading)

_2026-10-29_

**Decision.** `UNIQUE (charge_point_id, connector_id, started_at, meter_start_wh)`. Insert with
`ON CONFLICT DO NOTHING RETURNING transaction_id`; on a conflict, select the existing row and
return the same transactionId and the same idTagInfo as the first time.

**Why.** In OCPP 1.6 the server assigns the transactionId, so a retried StartTransaction must not
create a second session. The charger chooses all four fields, so a retry carries identical values.
Two real sessions can't share a connector, a start instant and a starting meter reading.

**Rejected.**

- _The OCPP message ID._ OCPP-J only requires it to be unique within one WebSocket connection, and
  a resend after a reconnect may carry a new one.
- _The time the server received it._ A charger that was offline sends StartTransaction hours
  late. The session started when the charger says it did.

## D-007 · Integers everywhere: int32 transaction ids, bigint watt-hours, exact decimal parsing

_2026-10-29_

**Decision.** `transaction_id` is a Postgres `integer`. Energy is `bigint` Wh. Meter values arrive
as strings, sometimes in kWh, and are parsed as exact decimals into integer Wh, never through a
float.

**Why.** The 1.6 schema only says "integer" for transactionId, and we can't assume every charger's
firmware handles more than 32 bits. Energy needs more room: 32-bit Wh tops out at 2.15 GWh, about
14,300 hours of a 150 kW charger at full output. And floats turn `0.1 + 0.2` into
`0.30000000000000004`, exactly the kind of discrepancy we've promised not to have.

## D-008 · Transaction messages never get a CALLERROR for a business reason

_2026-10-29_

**Decision.** StartTransaction, MeterValues and StopTransaction are stored, flagged if something's
wrong (unknown idTag, unknown transactionId), and acknowledged. Only malformed frames get a
CALLERROR.

**Why.** OCPP 1.6 lets a charger give up on a transaction message after `TransactionMessageAttempts`
error responses. A CALLERROR for "unknown transaction" would quietly delete billing data.

## D-009 · Energy is computed from stored evidence, never kept as a running total

_2026-10-29_

**Decision.** A session's energy is a pure function of its start reading, its stop reading, and
the energy-register readings between them, sorted by the charger's timestamps. For each
neighbouring pair (a, b): if b ≥ a, add b − a; otherwise the meter reset, so add b.

**Why.** Without a reset the answer is simply stop − start, so readings that are lost, duplicated
or out of order can't change it. Readings only matter around a reset. A running total would count
a duplicate twice and mishandle a late reading.

**Limit.** A reset is only visible when the next reading is lower than the last one. If the meter
resets and then climbs past its last reported value before reporting again (1,100 → reset →
1,500), the readings look exactly like a meter going from 1,100 to 1,500, and only 400 Wh is
billed. Chargers that report the register just before and just after a reboot
(`Interruption.Begin` and `Interruption.End` readings) make every reset visible. We bill what the
readings prove, so we can undercharge but never overcharge; a property test checks both.

**Later.** A jump bigger than the connector's max power × elapsed time gets flagged for review
instead of billed. That catches a meter "resetting" to a nonzero value.

## D-010 · Billing is checked against two ground truths

_2026-10-29_

**Decision.** For every simulated session the simulator records `physicalWh` (what actually
flowed) and `evidencedWh`: billing's rule (D-009) applied to the clean log of readings the charger
emitted, in the order it emitted them, before any network fault touches them. A run passes when
billed equals evidenced for every session, billed never exceeds physical, and the number of
sessions out equals the number in.

**Why.** If a meter resets before reporting its last few Wh, no backend can bill them. Measuring
against physical energy would make "zero discrepancies" impossible; measuring against nothing
would make it meaningless.

**Independence.** It comes from the data path, and from a second implementation. The simulator's
meter folds the rule over its clean log as it emits readings; billing sorts whatever survived the
network into Postgres. A property test feeds both random scripts of charging, readings and
resets, delivered in random order, and checks they agree.

**Correction (2026-10-29).** The first version of this entry had the checker compute evidence from
the simulator's private record of when each reset happened. That's wrong for the hidden reset in
D-009: the readings 1,100 → 1,500 can't prove a reset happened, so no backend could bill the
energy that checker expected. Designing the cross-check exposed it. The checker now counts only
what the readings prove.

## D-011 · Seeds reproduce scenarios; recorded traces reproduce runs

_2026-10-29_

**Decision.** Every random choice comes from `Prng` in `@voltline/common` (sfc32), split into named
streams with `fork(label)`. `Math.random` fails lint. Property tests (fast-check) print their seed
when they fail, and `VOLTLINE_SEED=<seed> pnpm test` replays it. Distributed runs also record every
message as it was delivered (the `ocpp_frames` table).

**Why.** A seed fixes what we generate: which charger misbehaves, when, and how. It can't fix OS
scheduling, network timing, or the exact moment a pod dies. So we claim "reproducible scenarios,
replayable traces", not "exactly reproducible runs".

**Streams.** `fork('charger-17')` depends only on the parent's seed and the label, never on how
many numbers the parent has drawn. Adding a random call in one charger doesn't shift what any
other charger sees. A test checks that 2,000 chargers get 2,000 distinct streams.

## D-012 · Raw SQL, no ORM; migrations are numbered SQL files run in one transaction

_2026-10-29_

**Decision.** `pg` with hand-written SQL. Migrations live in `packages/db/migrations/NNNN_name.sql`
and are applied together in one transaction under a Postgres advisory lock.

**Why.** Idempotent ingestion depends on exact `ON CONFLICT` clauses, row locks and transaction
boundaries, which an ORM hides. TimescaleDB hypertables need raw SQL anyway. The advisory lock
lets several gateway pods start at once and all run the migrator: one migrates, the rest wait and
find nothing to do (tested). Postgres DDL is transactional, so a failed migration leaves no
half-applied schema.

**Cost.** `CREATE INDEX CONCURRENTLY` can't run inside a transaction, so it can't be used in
migrations. Fine at our data sizes.

## D-013 · A meter has one value per instant

_2026-10-29_

**Decision.** `meter_readings` is unique on (charger, connector, measurand, phase, location,
timestamp). Duplicates are dropped with `ON CONFLICT DO NOTHING`. `phase` is stored as `''` rather
than NULL.

**Why.** The same reading often arrives twice: a retried MeterValues, or the last sample repeated
in StopTransaction's `transactionData`. Postgres treats NULLs as distinct in unique keys, so a
NULL phase would let duplicates through. TimescaleDB requires the time column in every unique index
on a hypertable, and this key includes it.

## D-014 · Each integration-test file gets its own schema

_2026-10-29_

**Decision.** `createTestDatabase()` creates a throwaway schema, runs the migrations into it, and
drops it afterwards. TimescaleDB's functions stay in `public`, which is second on the search path.

**Why.** Test files run in parallel without sharing tables. Dropping the schema removes everything,
including TimescaleDB's chunks (checked: no leftovers after a test run).

## D-015 · Container images are pinned to exact versions

_2026-10-29_

**Decision.** `timescale/timescaledb:2.31.0-pg17` and `redis:8.10.3-alpine`, with TimescaleDB
telemetry turned off.

**Why.** Reproducible results need the same database on every machine. A floating `latest` tag
means two laptops can quietly run different versions.

## D-016 · Smart-charging safety is measured on applied limits, with a usefulness metric (planned)

_2026-10-29_

**Decision.** Result 2 checks the limits the simulated chargers actually apply, not what the
backend believes. The total counts idle connectors at their default limit, increases sent but not
yet acknowledged, and offline chargers at their fallback limit. Increases go out only after the
decreases they depend on are acknowledged. The safety result is always reported next to how much
of the free capacity was allocated, and how fast.

**Why.** Allocating zero to everyone never exceeds the cap. A safety claim without a usefulness
number is empty.

## D-017 · Only registered chargers may connect, and a charger's newest connection wins

_2026-10-29_

**Decision.** A charger connects to `ws://…/ocpp/{chargePointId}` offering the `ocpp1.6`
subprotocol. The identity must already be a row in `charge_points`, or the upgrade is refused with
HTTP 404 before any WebSocket exists; without `ocpp1.6` it's refused with HTTP 400.
BootNotification updates a charger's details but never creates one. If a charger opens a second
connection, the gateway closes the first.

**Why.** Anyone can open a WebSocket. Checking the registry at the upgrade means a stranger can't
write anything. A charger that reconnects has already given up on its old socket, so the old one
is the stale one.

**Later.** Until the Basic-auth security profile (a stretch goal), knowing a registered identity
is enough to connect. Across several gateway pods, "newest wins" needs the Redis registry (M3).

## D-018 · Each charger's CALLs are answered one at a time; answers to our own CALLs skip the queue

_2026-10-29_

**Decision.** A connection answers the charger's CALLs strictly in arrival order, one at a time.
CALLRESULTs and CALLERRORs, which answer CALLs we sent, are settled the moment they arrive. Our own
CALLs to a charger also go out one at a time.

**Why.** In order, because a session's StartTransaction must be committed before its first
MeterValues is handled. One at a time outwards, because OCPP-J says not to send a new CALL until
the previous one is answered or has timed out. Answers skip the queue because a handler waiting on
the charger's answer to one of our CALLs would otherwise be stuck behind itself forever. A unit
test reproduces exactly that case.

## D-019 · Every message is checked against the official schemas

_2026-10-29_

**Decision.** Every CALL a charger sends is validated with Ajv against the vendored OCA schemas
before a handler sees it. A failure maps to the closest OCPP 1.6 error code: a missing field is
OccurenceConstraintViolation, a wrong type TypeConstraintViolation, a bad value
PropertyConstraintViolation, and an unknown field FormationViolation. In tests, the gateway's own
responses and the simulator's requests are validated too. Payload types are generated from the
same schemas (`pnpm ocpp:types`).

**Why.** The schemas are the contract. Generating types from them means a handler can't compile
against a field the validator would reject.

**Quirks, handled in code because the files stay untouched.** The schemas are draft-04, which
Ajv 8 only loads through `ajv-draft-04`. They put `additionalProperties` on string enums, which
Ajv's strict mode rejects (`strict: false`). Charging limits must be multiples of 0.1, and
0.3 / 0.1 is 2.9999999999999996 in floating point (`multipleOfPrecision`; a test shows a default
Ajv rejecting a valid 0.3 A limit).

## D-020 · Id tags are case-insensitive

_2026-10-29_

**Decision.** Tags are matched with `lower(id_tag)`, and a unique index on `lower(id_tag)` stops
"abc" and "ABC" being stored as two tags.

**Why.** OCPP 1.6's IdToken is a CiString20, case-insensitive by definition. A card read as "abc"
by one charger and "ABC" by another is the same card.

## D-021 · Connector status: the newest report wins, decided inside Redis

_2026-10-29_

**Decision.** Each connector's status is one Redis hash. A Lua script replaces it only if the new
report's timestamp is at least as new as the stored one, and then replaces every field. Without a
charger timestamp (optional in 1.6), the time we received it is used.

**Why.** Status reports can arrive out of order, for example a queued message flushed after a
reconnect. Comparing and writing in one atomic script means two gateways can't interleave a read
and a write.

## D-022 · Billing trusts only the charger's timestamps, so the simulator can compress time

_2026-10-29_

**Decision.** A session's start, stop and readings use the timestamps in the messages, never the
time the server received them. The simulator runs each charger on a virtual clock.

**Why.** A charger that was offline sends its messages late, but the session still happened when
the charger says it did. It also means a simulated hour of charging takes milliseconds, which is
what makes 5,000-session runs practical.
