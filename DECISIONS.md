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

**Update (M2).** A StopTransaction for an unknown session is now kept too: the frame log (D-023)
stores every frame, so the evidence is there to review.

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

## D-016 · Smart-charging safety is measured on applied limits, with a usefulness metric

_2026-10-29_

**Decision.** Result 2 checks the limits the simulated chargers actually apply, not what the
backend believes. The total counts idle connectors at their default limit, increases sent but not
yet acknowledged, and offline chargers at their fallback limit. Increases go out only after the
decreases they depend on are acknowledged. The safety result is always reported next to how much
of the free capacity was allocated, and how fast.

**Why.** Allocating zero to everyone never exceeds the cap. A safety claim without a usefulness
number is empty.

**Update (D-032).** Both are measured now, from the chargers' own record of the limits they apply.

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

## D-023 · Every frame is logged, and a charger's trace can be replayed

_2026-10-29_

**Decision.** The gateway records every frame in and out to `ocpp_frames`, in batches and off the
critical path, with its connection id and its position in that connection. `replayCalls` feeds a
charger's recorded CALLs through the same handlers again, in the recorded order, with the clock
set to each call's original arrival time.

**Why.** Seeds reproduce scenarios, not runs (D-011). When a distributed run fails, the recorded
trace is what lets us reproduce exactly what billing saw. Every M2 run also replays every charger
into an empty database and checks that all the bills come out the same.

**Transaction-id translation.** In OCPP 1.6 the server assigns transaction ids, and the replay
database assigns its own, in a different order. So the replay reads each StartTransaction's
recorded answer, maps the original id to the new one, and rewrites later MeterValues and
StopTransaction to match. The first version skipped this and got almost every bill wrong; the
replay test caught it.

**Cost.** Frames still in the buffer when a process dies are lost. That costs a trace, never money:
billing commits its own evidence before any ack goes out (D-005).

**Update (M3): the log is now a group commit.** With gateways being killed, "frames lost in a
crash" would mean replay fails exactly when it matters most. So a gateway now sends its answer to
a charger only after the frame log has stored the CALL and the answer. All connections share each
write (one INSERT every few milliseconds), so it costs a few milliseconds of latency per answer,
not throughput. Any CALL whose answer reached a charger is now always in the log. A frame lost in a
crash belongs to a CALL the charger never got an answer for, so the charger sends it again, and
that copy is logged. The 500-session M2 run went from 3.5 s to 4.8 s.

## D-024 · A reading that arrives after its session stopped re-bills the session

_2026-10-29_

**Decision.** When new readings belong to a session that has already stopped, it's billed again
from all its evidence, under the session's row lock. The readings' insert commits on its own
first; only then is the lock taken. A second StopTransaction that contradicts the first leaves the
first bill in place and marks the session `needs_review`.

**Why.** A charger flushing a shuffled offline queue can deliver MeterValues after StopTransaction,
and around a meter reset such a reading changes the bill. Because the insert commits before the
lock, a stop racing with the reading either sees the reading or commits first and is then
re-billed. A test races the two 20 times.

## D-025 · How the simulator misbehaves

_2026-10-29_

**Decision.** Each simulated charger keeps StartTransaction, MeterValues and StopTransaction in an
outbox and resends each until it gets an answer: at-least-once delivery, as OCPP 1.6 asks of
chargers. On top of that, each charger's seeded stream decides:

- **Offline spells.** A third begin before the session does, so its StartTransaction is sent late.
- **Lost answers.** The charger sends the same message again.
- **Connections dropped right after sending.** The charger reconnects and sends it again.
- **Shuffled queues** after an offline spell. StartTransaction stays first, because nothing else
  can carry a transactionId before that answer arrives.
- **Meter resets.** Reported with `Interruption.Begin` and `Interruption.End` readings, or
  unreported.

**Why.** These are the ways deliveries go wrong without anything being lost for good, which is the
contract billing has to survive. Each test run asserts that every kind of fault actually happened,
so a run can't pass by quietly injecting nothing.

**Not modelled yet.** Charger clock jumps, chargers that give up on a message for good, and
gateway crashes (M3).

## D-026 · Dead connections are found with WebSocket pings

_2026-10-29_

**Decision.** Every 30 s the gateway pings each socket. If the previous ping got no pong, the
socket is terminated.

**Why.** A charger whose network vanishes sends no closing frame, so its socket looks open forever
and its identity stays bound to a dead connection. A test checks both sides: a client that stops
answering is dropped, and one that answers is kept.

## D-027 · Milestone 2 focuses on billing; commands and allocation move to Milestone 3

_2026-10-29_

**Decision.** RemoteStartTransaction, RemoteStopTransaction, TriggerMessage and the smart-charging
allocator moved from M2 to M3.

**Why.** With one builder instead of four teammates working in parallel, order matters more.
Server-initiated commands belong with cross-pod command routing (M3), and the allocator with the
charging controller that uses it (M3). M2 stays on its exit check.

## D-028 · Chargers reconnect with exponential backoff and jitter, on a separate random stream

_2026-10-30_

**Decision.** When a connection breaks or is refused, a simulated charger connects again, to a
gateway picked at random from its list. Between failed tries it waits a random time between 0 and
min(2 s, 50 ms × 2^n), where n is the number of failures so far ("full jitter"). Then it sends the
unanswered message again. These network choices come from their own random stream, forked from
the charger's seed by name.

**Why.** Backoff stops a crowd of chargers from hammering a gateway that is starting up, and the
jitter stops them all retrying at the same instant. The separate stream matters for testing: how
often a charger reconnects depends on crash timing, which no seed controls. If those choices used
the main stream, one extra reconnect would shift every later decision the charger makes. With two
streams, a seed reproduces the chargers' behaviour exactly even under crashes: rerunning seed 1
gave identical faults and energy, and only the reconnect count changed (377, then 402).

## D-029 · Crash tests use real processes and SIGKILL, never the last gateway

_2026-10-30_

**Decision.** The crash tests start real gateway processes and kill them with SIGKILL on a seeded
schedule, restarting each one shortly after, on the same port. At most one gateway is down at a
time.

**Why.** SIGKILL is the honest crash: the process gets no chance to close sockets, finish
transactions or flush buffers, exactly like a power cut or an out-of-memory kill. A gentle
SIGTERM would let the gateway tidy up and hide bugs. Keeping one gateway up means chargers always
have somewhere to go, so the test measures billing correctness rather than a total outage (a total
outage is part of the recovery test in Milestone 5).

## D-030 · Commands reach a charger through a Redis registry and pub/sub, not a durable queue

_2026-10-30_

**Decision.** A Redis registry records which gateway holds each charger's socket, plus a counter
(the epoch) that grows with every new connection. To send a command (RemoteStartTransaction,
TriggerMessage…), any process looks up the owner and publishes the command on that gateway's
Redis channel. The gateway sends it to the charger, checks the answer against the schema, and
publishes the outcome back. When a charger connects to a new gateway, the previous owner is told
to close its stale socket. The REST API (`services/api`) keeps no state of its own, so any number
of copies can run.

**Why.**

- **Not a durable queue.** A RemoteStartTransaction delivered a minute late is worse than one that
  fails: the driver has walked away. So a command gets an answer within a timeout, or the caller
  is told it didn't, and can retry with fresh information.
- **Failing fast.** If Redis reports that nobody received the published command, the gateway named
  in the registry is dead. The caller hears "not connected" at once instead of waiting out the
  timeout.
- **Safe unregistering.** A connection removes itself from the registry only if it is still the
  owner, so an old socket closing late can't erase the new one.

**Known edge.** If two gateways register the same charger at almost the same moment, the last write
wins. In the rare case where that closes the newer socket, the charger simply reconnects and
registers again. That heals itself, so it isn't worth a distributed lock.

## D-031 · Smart charging: fair targets, and a controller step that is safe at every moment

_2026-10-30_

**Decision.** Targets come from max-min fair "water filling" over the power left after every
connector's default limit: each round, every car still wanting more gets an equal share. The
controller is a pure, level-triggered function of the current state, and follows four rules:

1. Decreases go first.
2. No increase is sent while a decrease is unconfirmed.
3. An increase only uses power that is free even in the worst case, counting changes still in
   flight.
4. Each connector has at most one change in flight.

A site whose defaults alone exceed its cap is refused when it is configured.

_Rule 2 was replaced after measuring it with lost answers: see D-033._

**Why.** "Never exceeds the cap" must hold at every moment, not just after things settle, and it
must hold even when answers are lost, refused or late. A property test plays random sequences of
up to 300 events against the controller: cars arriving and leaving, changes accepted, rejected or
lost, chargers going offline, leases expiring. It checks the worst case after every single event.

A second property checks that the controller always reaches its targets once chargers answer
again. Without it, a controller that allocates nothing would pass the safety test (D-016).

**Not yet.** The controller service that sends SetChargingProfile through the command bus with
`validTo` leases, and the simulator's model of how chargers apply profiles. Both came next: see
D-032.

## D-032 · The charging controller: leases, unknown answers, and the chargers' own record

_2026-10-30_

**Decision.** One controller per site (`services/charging-controller`). Every tick (1 s in
production, 50 ms in tests) it reads the site as it is now: the cap, the chargers and their open
sessions from Postgres, and who is connected from the Redis registry. It works out fair targets
(D-031) and sends the next safe changes as SetChargingProfile through the command bus (D-030).

- **Every limit is a lease.** Each TxProfile carries `validTo`, 30 s ahead by default. The
  controller refreshes it once half is used up. A charger that stops hearing from us falls back to
  its default by itself when the lease ends.
- **Three kinds of outcome.** An answer tells us where the charger stands. A command that never
  went out (charger not connected, invalid payload) changed nothing. No answer means _unknown_:
  the change counts as "maybe applied" until its lease would be over, plus 2 s for clocks that
  disagree. After that the charger is on its default, whatever it did.
- **A connection that closes after the command went out is unknown too,** not "not connected".
  The charger may have applied the limit just before its socket died. The gateway's command path
  first got this wrong; the controller is what made it matter.
- **Ticks don't wait for answers.** Answers update the controller's belief when they arrive. A late
  answer to a change it already gave up on is ignored. So one charger that never answers can't
  hold up the rest of the site.
- **A fresh controller waits before it sends anything.** It remembers nothing, so it believes every
  charger is on its default. But a charger may still hold a high limit from before a crash or a
  deploy. So for one lease plus the clock allowance, a new controller sends nothing; by then every
  old lease is over.
- **Exactly one controller per site, and only it sets limits.** Two controllers would each think
  the spare power is theirs to give. In Kubernetes (M4) this is one replica with
  `strategy: Recreate`. The REST API refuses SetChargingProfile and ClearChargingProfile, because a
  limit set by hand would be invisible to the controller.

The simulated chargers follow the parts of OCPP 1.6 the controller relies on. Without a TxProfile
they apply their default (the TxDefaultProfile). A TxProfile applies only to its own transaction
and is dropped when that ends. It stops at `validTo`, and one that arrives already expired never
applies. A charger applies a new profile at the moment it answers, after a seeded delay. It may
refuse it, and its answer may be lost.

**How it is checked.** A recorder notes every limit each simulated charger actually applies, with
a timestamp. The peak is the highest total at any moment, with idle connectors at their default.
The controller's beliefs play no part in the verdict. Usefulness (D-016) comes from the same
record: over time, the share of the spare power (the cap minus every connector's default) the
chargers were allowed to use, out of the most that could have been handed out at each moment.
Two negative controls prove the check can fail. The same scenario with a careless planner (every
target at once, no ordering, no worst-case budget) must break the cap. And a scripted restart must
break it without the waiting period: car A holds all the spare power, its charger drops offline
keeping that limit, the controller restarts, and car B arrives. With no wait, the new controller
gives B a share at once and the site reaches 38,790 W against a 30,000 W cap. With the wait it
stays at 30,000 W.

**Why.**

- **Leases make safety local.** Without one, a charger we lose contact with would keep its high
  limit forever, and its power could never be given to anyone else.
- **"Unknown" is the honest answer to a timeout.** Treating a timeout as "not applied" is the
  classic bug: the same power goes to a second car while the first charger may still be using it.
- **The check must not share the controller's mistakes.** If it read the controller's beliefs, a
  bug in those beliefs would hide itself.
- **Found while building it.** The first cap test failed with a peak of 120,420 W against a
  60,000 W cap. The bug was in the simulator: a charger didn't record falling back to its default
  when a session stopped, so the recorder kept counting the old limit. A check that fails for the
  wrong reason still deserves a close look.

**Known limits.**

- If the answer to a lease refresh is lost, the charger can sit on its default for up to the
  clock allowance plus one tick before the controller raises it again. Safe, slightly wasteful.
- Leases assume the charger's clock roughly agrees with ours. The 2 s allowance covers small
  differences, not a charger whose clock is minutes off.
- The simulator models one connector per charger and a single stack level.

## D-033 · An unconfirmed decrease no longer holds back other increases

_2026-10-30_

**Decision.** D-031's rule "no increase is sent while a decrease is unconfirmed" is replaced. An
increase may go out while some decrease is still unconfirmed, but only into power that is free
with every connector at its worst case. A connector with an unconfirmed decrease still counts at
its old, higher limit, so no increase ever relies on a decrease that hasn't been confirmed.

**Why.** Once the simulated chargers could lose answers (D-032), the strict rule showed a hidden
cost. A decrease whose answer is lost stays unconfirmed until its lease would be over, and the
strict rule froze every increase on the site for that long: 1.8 s in the tests, 32 s in
production. Measured with 200 load changes 150 to 450 ms apart, 8 chargers, a 60 kW cap, and all
charger faults on:

| Seed | Usefulness, strict rule | Usefulness, new rule | Peak (cap 60,000 W) |
| ---- | ----------------------- | -------------------- | ------------------- |
| 2028 | 75.0%                   | 83.0%                | 60,000 W both times |
| 1    | 75.7%                   | 84.3%                | 60,000 W both times |
| 2    | 78.6%                   | 85.9%                | 60,000 W both times |
| 3    | 81.9%                   | 85.8%                | 60,000 W both times |

The property tests (D-031) pass unchanged: the worst case stays under the cap after every event,
and every connector reaches its target once chargers answer again. A new example test shows the
difference: a third car gets the power a confirmed decrease freed, while another decrease is
still unanswered.

**What stays the same.** "Decreases go before increases" still holds in the sense that matters
for safety: no increase uses a watt until the charger giving it up has confirmed. The order in
which one tick's changes go out never mattered for safety.

## D-034 · Settlement: a bill is final once its evidence goes quiet; later evidence is a correction

_2026-10-30_

**Decision.** A session now goes active → stopped → settled.

- **When it settles.** A stopped session settles once no new evidence for it has arrived for a
  quiet period: 15 minutes by default. Evidence means its StopTransaction or any new reading for
  it. The bill at that moment is kept as `settled_energy_wh`, and that never changes again.
- **Evidence after that.** It is still stored, and the bill is still worked out again from all the
  evidence (D-009). If the amount changes, the change goes into a `bill_corrections` table: the
  old amount, the new one, and the difference. So at every moment, the settled bill plus all its
  corrections equals the current bill.
- **Review is a flag, not a state.** `needs_review` used to be a state. Now it is a separate
  column, because a session can need a person's attention whether it is stopped or settled. A
  flagged session is never settled automatically.
- **One statement, run anywhere.** Settlement is a single SQL update (`settleDueSessions`). It is
  safe to run in any process, as often as you like, several at once. `pnpm settle` runs it every
  minute; with `--once` it runs one pass and exits, as a Kubernetes CronJob would.

**Why.**

- **A settled bill goes out into the world.** It becomes an invoice, or a record sent to the
  driver's provider. After that, changing it quietly would make the books disagree. A correction
  is the honest way: the old bill stays as it was, and the difference is a separate, dated record.
- **The quiet period waits for chargers that are still catching up.** A charger that reconnects
  flushes its queue, and some readings can arrive after the stop. The clock starts again with each
  new piece of evidence, so a charger that is still sending holds its sessions back. The cost: a
  bill waits a while before it is final.
- **Corrections should be rare.** Late evidence only changes a bill around a meter reset (D-024),
  so a correction needs a reading that reveals a reset to arrive after its session settled.
- **Races are safe.** A late reading takes the session's row lock before it bills again. The
  settlement statement waits for that lock, then judges the session again as the reading left it
  (Postgres re-checks the `WHERE` on the new row version). So either the reading is in the settled
  bill, or it becomes a correction. A test races two settlers and a late reading 20 times, and the
  sum holds every time.

**How it is checked under faults.** The fault harness can run a settler with no quiet period
while chargers misbehave and gateways crash. Every session then settles within milliseconds of
its stop, so evidence that comes later has to go in as a correction. The checker requires every
session to be settled, its settled bill plus its corrections to equal its bill, and corrections
only on sessions that really had readings after their stop.

**Not yet.** A session whose StopTransaction never arrives stays active forever. Closing such
sessions after a long silence, and flagging them for review, is future work.

## D-035 · Reconnect storms are measured from the chargers' side, against real processes

_2026-10-30_

**Decision.** The simulator has a second kind of charger, the `IdleCharger`. It connects, boots,
reports its connector Available, and then stays connected doing nothing. When its connection
drops, it reconnects to a random gateway with exponential backoff and full jitter (D-028), and
records two times: when it noticed the loss, and when a gateway accepted its BootNotification
again. `pnpm storm` starts thousands of them at once against real gateway processes, kills one
gateway or all of them with SIGKILL, starts them again, and reports:

- for each charger, the time from noticing the loss to being accepted again, as percentiles
  (p50, p95, p99) and the maximum, never only an average;
- how many gave up, and how long until the last charger was back;
- a curve of how many chargers were connected, every 100 ms after the kill;
- a cross-check with the Redis registry: the chargers that noticed a loss must be exactly the ones
  the registry had placed on the killed gateways, and afterwards every charger must be registered.

**Why.**

- **The charger's side is the honest side.** A gateway only sees the connections that reach it.
  A charger that keeps failing to connect never shows up in the gateway's numbers at all.
- **Percentiles and the maximum, not averages.** The slowest chargers are the ones a car-park
  operator calls about. An average hides them.
- **The registry check catches a quiet failure.** If a charger never noticed that its gateway had
  died, its reconnect time couldn't be measured, and it would simply be missing from the numbers.
  Comparing with the registry shows that this didn't happen.
- **Idle chargers isolate the reconnect path.** Sessions, faults and billing are tested elsewhere.
  Here, every message is a BootNotification or a StatusNotification.

**What the baseline showed.** `--no-jitter` makes every charger wait the full backoff, so they all
retry in step. After a full outage, that brought all 2,000 back about 0.6 s _sooner_ than with
jitter, in one wave the gateways absorbed within half a second. So jitter (D-028) is not about
speed. It protects the gateways when a wave is bigger than they can take: chargers in step then
fail together and retry together. Here the gateways had capacity to spare. The real test comes
with BootNotification rate limiting in Milestone 4.

**Known limits.**

- Everything runs on one machine, and SIGKILL makes the kernel reset the sockets at once, so a
  charger notices the loss immediately. Across a real network a dead peer may send nothing, and
  noticing takes until the WebSocket ping times out (D-026). The numbers are a lower bound.
- The backoff cap is 2 s, as everywhere in the tests. With a longer cap, recovery after a full
  outage takes longer, by about one cap.
- Connections don't rebalance after a restart: a gateway that comes back late stays almost empty.
  That needs a rebalancing rule in Milestone 4 or later.
