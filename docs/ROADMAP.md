# Roadmap

Twelve weeks, six milestones. Each milestone ends with a demo and a git tag (`v0.1` … `v0.6`), and
isn't done until its exit check passes. Design reasoning lives in [DECISIONS.md](../DECISIONS.md).

## M0 · Project setup (done)

- [x] pnpm workspace, strict TypeScript run directly by Node 24, type-aware ESLint, Prettier, Vitest + fast-check
- [x] TimescaleDB and Redis via docker compose, pinned versions
- [x] Database schema: sites, charge points, id tags, transactions, meter readings, raw OCPP frames
- [x] Seeded PRNG with named streams; injectable clock
- [x] `pnpm prereqs` checks this machine's prerequisites
- [x] OCPP 1.6 JSON schemas copied into `packages/ocpp/schemas/v1.6/`, byte-identical to the OCA download

## M1 · Weeks 1–2 · One charger, one session, end to end (done, except the kind trial)

**Exit check:** a simulated charger boots, authorizes, charges and stops; the stored energy equals
the simulator's ground truth; resending StartTransaction returns the same transactionId;
`pnpm check` and `pnpm test:integration` pass on a fresh clone.

- [x] `ocpp`: frame parsing, validation against the official schemas, 1.6 error codes, payload types generated from the schemas
- [x] `gateway`: WebSocket server at `/ocpp/{chargePointId}` requiring subprotocol `ocpp1.6`; CALL/CALLRESULT/CALLERROR matched by message ID with timeouts; one message at a time per charger
- [x] Handlers for BootNotification, Heartbeat, StatusNotification, Authorize, StartTransaction, MeterValues, StopTransaction, each saving before it acks (plus trivial answers for DataTransfer, DiagnosticsStatusNotification, FirmwareStatusNotification)
- [x] `billing`: idempotent ingestion and the energy function, with property tests
- [x] `availability`: connector status in Redis, newest timestamp wins
- [x] `simulator`: one well-behaved, seeded charger recording physical and evidenced energy
- [x] End-to-end test of a full session, plus `pnpm smoke` through the real gateway process and simulator CLI
- [ ] kind trial run: 2,000 WebSocket connections into one pod from a Job inside the cluster

**Known gaps, carried into M2:** a StopTransaction for an unknown session is acknowledged and
logged but not stored (that needs the raw frame log); readings that arrive after their session's
stop are stored but don't trigger a re-bill yet.

## M2 · Weeks 3–4 · Correct under faults, one gateway

**Exit check:** 500 seeded sessions with duplicates, offline replay (late StartTransaction),
out-of-order MeterValues and meter resets give 0 discrepancies and 0 lost or invented sessions;
any failure replays from its trace.

- [ ] Billing state machine (active → stopped → settled, plus needs_review), write-once stops, recalculation under a row lock
- [ ] Simulator fault injection, scenario generator, per-session report (billed / evidenced / physical)
- [ ] Gateway: queue for server-sent CALLs (one in flight per charger), newest connection wins, ping/pong dead-socket detection, raw frame log
- [ ] RemoteStartTransaction, RemoteStopTransaction, TriggerMessage
- [ ] Trace capture and replay into billing
- [ ] Smart-charging allocator and change planner (pure functions, property-tested at every step of a plan)

## M3 · Weeks 5–6 · Several gateways, cross-pod commands, smart charging v1

**Exit check:** 5,000 sessions survive gateway process kills with 0 discrepancies; a command sent
through gateway A reaches a charger connected to gateway B; the cap holds across 200 load changes.

- [ ] Redis connection registry with a per-connection counter, so a stale socket on the old pod gets closed instead of used
- [ ] Pod-to-pod commands over Redis pub/sub with a reply and a timeout (deliberately not a durable queue)
- [ ] Graceful shutdown on SIGTERM
- [ ] Simulator: 2,000 concurrent chargers, exponential backoff with jitter, charger-side charging profiles (stack levels, `validTo`, TxDefaultProfile fallback), applied-limit checker
- [ ] charging-controller: reconcile loop, increases only after decreases are acknowledged, short `validTo` leases
- [ ] Settlement and late-evidence corrections; sessions API; availability REST API

## M4 · Weeks 7–8 · Kubernetes

**Exit check:** one script brings the whole system up in kind, and result 1 reproduces there with
real pod kills.

- [ ] Docker images, kind config, manifests (gateway ×3, api, controller with `strategy: Recreate`, Postgres and Redis StatefulSets)
- [ ] Readiness and liveness probes, preStop hook, connections closed gradually at shutdown
- [ ] BootNotification rate limiting: Redis token bucket, answering `Pending` with an `interval` when over budget
- [ ] Simulator as a Job inside the cluster; chaos driver that kills pods on a seeded schedule
- [ ] **Result 1** write-up
- [ ] **Result 2:** 1,000 load changes, including chargers dropping mid-change and decreases that are rejected or time out, plus the usefulness metric

## M5 · Weeks 9–10 · Reconnect storm and interoperability

**Exit check:** result 3 measured in three scenarios over several runs, with every run reported;
SAP's simulator completes a session and accepts a SetChargingProfile.

- [ ] **Result 3:** kill 1 of 3 gateway pods, rolling restart, and all pods down. Measured from the chargers' side: time to reconnect and to the first accepted message (p50/p95/p99/max), attempts, Pending boots, and how unevenly connections spread across pods. Includes a baseline without jitter or rate limiting. Never through `kubectl port-forward`.
- [ ] Interop with SAP's e-mobility charging station simulator; every incompatibility logged in DECISIONS.md
- [ ] Smart charging under chaos (controller and gateway pods killed mid-change)

## M6 · Weeks 11–12 · Buffer and write-up

**Exit check:** each result reproduces with one command; README, architecture diagram, results
with limitations, and a five-minute demo.

- [ ] Fix whatever M4 and M5 broke
- [ ] `docs/results/`: command, seed, date, raw numbers and limitations for each result
- [ ] Stretch, only if ahead: OCPP 2.0.1 subset, Basic-auth security profile, Prometheus/Grafana
