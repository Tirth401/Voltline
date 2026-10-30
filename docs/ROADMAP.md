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

## M1 · Weeks 1–2 · One charger, one session, end to end (done)

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
- [x] kind trial run: 2,000 WebSocket connections into one pod from a Job inside the cluster (done in M4: [results](results/m4-kind-trial-and-rebalancing.md))

**Known gaps found in M1, both fixed in M2:** a StopTransaction for an unknown session was
acknowledged but not stored (the frame log now keeps it), and readings that arrived after their
session's stop didn't trigger a re-bill (they do now, D-024).

## M2 · Weeks 3–4 · Correct under faults, one gateway (done)

**Exit check:** 500 seeded sessions with duplicates, offline replay (late StartTransaction),
out-of-order MeterValues and meter resets give 0 discrepancies and 0 lost or invented sessions;
any failure replays from its trace.

**Result:** three seeds of 500 sessions, each with 0 discrepancies, 0 lost, 0 invented, and every
bill reproduced by replay. Details and limitations:
[results/m2-billing-under-faults.md](results/m2-billing-under-faults.md).

- [x] Billing: late readings re-bill a stopped session under its row lock; stops are write-once; a conflicting second stop marks the session needs_review
- [x] Simulator: a charger outbox that resends until answered; seeded fault plans (offline spells and late starts, lost answers, dropped connections, shuffled queues, reported and unreported meter resets); a fleet runner
- [x] Per-session check (billed / evidenced / physical, readings, transaction ids) and `pnpm faults`
- [x] Gateway: raw frame log and ping/pong dead-connection detection (the one-in-flight CALL queue and newest-connection-wins were already done in M1)
- [x] Trace capture and replay into billing, with transaction-id translation; `pnpm replay`
- Moved to M3 (D-027): RemoteStartTransaction, RemoteStopTransaction, TriggerMessage, and the smart-charging allocator and change planner
- Moved to M3, as planned: settlement (active → stopped → settled)

## M3 · Weeks 5–6 · Several gateways, cross-pod commands, smart charging v1 (done)

**Exit check:** 5,000 sessions survive gateway process kills with 0 discrepancies; a command sent
through the API reaches a charger through whichever gateway holds it; the cap holds across 200
load changes.

**Done:** all three parts of the exit check, settlement, and a simulator that holds 2,000
chargers through a reconnect storm.

- **Billing under crashes:** 5,000 sessions with gateway kills, on three seeds. Every run had
  0 discrepancies, 0 lost, 0 invented, and every bill was rebuilt by replay
  ([results](results/m3-billing-with-gateway-kills.md)).
- **Commands:** a command sent through the API reaches a charger on another gateway, and a charger
  moving between gateways makes the old one close its stale socket (both tested).
- **Smart charging:** the cap held in every run, by the chargers' own record of what they applied:
  200 load changes in the integration test, plus ten runs of 1,000 load changes with chargers
  refusing limits, losing answers and dropping offline, and the controller restarting. Two broken
  controllers break the cap in the integration tests, so the check can fail. Usefulness is
  reported next to safety: 88–89% at a calm pace ([results](results/m3-smart-charging-cap.md)).
- **Settlement:** every session settled while gateways were being killed, and every bill that
  changed after settling did so through a correction ([results](results/m3-settlement-corrections.md)).
- **2,000 chargers:** after killing one gateway, or all three, every charger came back and the
  registry agreed on where each one was ([results](results/m3-reconnect-storm.md)).

- [x] RemoteStartTransaction, RemoteStopTransaction and TriggerMessage, plus any other CSMS command, all checked against the schemas, through `POST /chargers/:id/commands/:action`
- [x] Redis connection registry with a per-connection counter (the epoch); a stale socket on the old gateway is closed
- [x] Gateway-to-gateway commands over Redis pub/sub, with a reply and a timeout (deliberately not a durable queue)
- [x] Graceful shutdown on SIGTERM (gateway and API); connection draining comes with Kubernetes in M4
- [x] Simulator: reconnects with exponential backoff and jitter across several gateways; remote mode, answering RemoteStart, RemoteStop and TriggerMessage
- [x] Frame log as a group commit, so replay survives SIGKILL
- [x] Sessions API and availability REST API (`services/api`)
- [x] Smart-charging allocator and change planner: pure functions, property-tested after every event of random scenarios (D-031)
- [x] Simulator: charger-side charging profiles (one stack level, `validTo` leases, TxDefaultProfile fallback), lost answers, and the applied-limit recorder (D-032)
- [x] charging-controller: reconcile loop that never waits for answers, unknown outcomes held until their lease is over, a waiting period after each start (D-032, D-033)
- [x] REST API refuses SetChargingProfile and ClearChargingProfile: limits belong to the controller
- [x] Settlement and late-evidence corrections: a bill settles once its evidence goes quiet, and later evidence becomes a correction (D-034, [results](results/m3-settlement-corrections.md))
- [x] Simulator at 2,000 concurrent chargers: idle chargers that measure their own reconnects, `pnpm storm`, and a no-jitter baseline (D-035)

## M4 · Weeks 7–8 · Kubernetes (done)

**Exit check:** one script brings the whole system up in kind, and result 1 reproduces there with
real pod kills.

**Done.** `pnpm kind:up` brings the whole system up in kind, and result 1 reproduced there: six runs
of 5,000 sessions with gateway pods killed in three ways, each with 0 discrepancies, 0 lost,
0 invented and 0 replay mismatches ([results](results/m4-billing-with-pod-kills.md)). The first
batch of those runs failed twice and found a simulator bug; that batch is reported too.

- [x] Docker images, kind config, manifests: one image for every process, gateway ×3, api,
      controller with `strategy: Recreate`, settlement as a CronJob, Postgres and Redis StatefulSets,
      migrations as a Job (D-036)
- [x] Readiness and liveness probes, preStop hook, connections closed gradually at shutdown (D-037)
- [x] BootNotification rate limiting: a Redis token bucket shared by all gateways, answering
      `Pending` with each charger's own appointment (D-038)
- [x] Simulator as a Job inside the cluster; chaos driver that kills pods on a seeded schedule, in
      three ways: crash, delete, drain (D-040)
- [x] **Result 1** write-up ([results](results/m4-billing-with-pod-kills.md))
- [x] The kind trial left over from M1: 2,000 chargers into one pod
      ([results](results/m4-kind-trial-and-rebalancing.md))
- [x] Connection rebalancing after a gateway restart, found missing in M3 (D-039,
      [results](results/m4-kind-trial-and-rebalancing.md))
- Moved to M5, which already plans "smart charging under chaos": **result 2** in kind, with the
  controller and gateway pods killed. In M3 it ran outside Kubernetes, with controller restarts,
  refused and lost changes ([results](results/m3-smart-charging-cap.md)).

## M5 · Weeks 9–10 · Reconnect storm and interoperability

**Exit check:** result 3 measured in three scenarios over several runs, with every run reported;
SAP's simulator completes a session and accepts a SetChargingProfile.

- [ ] **Result 3:** kill 1 of 3 gateway pods, rolling restart, and all pods down (already measured with processes on one laptop in M3: [results](results/m3-reconnect-storm.md)). Measured from the chargers' side: time to reconnect and to the first accepted message (p50/p95/p99/max), attempts, Pending boots, and how unevenly connections spread across pods. Includes a baseline without jitter or rate limiting. Never through `kubectl port-forward`. The tools exist since M4 (`pnpm kind:storm`, D-040), and single runs of each kill mode are in [results](results/m4-kind-trial-and-rebalancing.md).
- [ ] Idle chargers that notice a dead connection by themselves (WebSocket pings or Heartbeats), so a connection that dies silently is counted honestly
- [ ] Interop with SAP's e-mobility charging station simulator; every incompatibility logged in DECISIONS.md
- [ ] Smart charging under chaos (controller and gateway pods killed mid-change): **result 2** in kind, moved from M4

## M6 · Weeks 11–12 · Buffer and write-up

**Exit check:** each result reproduces with one command; README, architecture diagram, results
with limitations, and a five-minute demo.

- [ ] Fix whatever M4 and M5 broke
- [ ] `docs/results/`: command, seed, date, raw numbers and limitations for each result
- [ ] Stretch, only if ahead: OCPP 2.0.1 subset, Basic-auth security profile, Prometheus/Grafana
