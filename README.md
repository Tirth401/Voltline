# Voltline

A simplified EV charging backend (a Charge Station Management System, or CSMS) that talks to
chargers using OCPP 1.6J over WebSockets. It rebuilds the hard core of a real charging network:
billing that stays exact when chargers misbehave, site power caps that are never exceeded, and
fast recovery when the gateway restarts.

> **Status:** Milestone 4 is done: the whole system runs in Kubernetes (kind) with one command.
> The reconnect-storm result and interoperability (Milestone 5) are next.
>
> - **Billing under pod kills:** 5,000 seeded sessions full of faults are billed to the watt-hour
>   inside Kubernetes while gateway pods are crashed, deleted and drained as they run (six final
>   runs out of six; the first batch found a simulator bug, and is reported too).
> - **Kubernetes:** `pnpm kind:up` brings everything up. Gateways drain gradually when stopped,
>   share a budget for BootNotifications, and rebalance their connections after a restart.
> - **Commands:** commands reach a charger through whichever gateway holds its connection.
> - **Smart charging:** a controller keeps each site under its power cap. Over 1,000 load changes,
>   with chargers refusing limits, losing answers and dropping offline, and the controller
>   restarting, the limits the chargers applied never added up to more than the cap (ten runs out
>   of ten). At a calm pace the chargers got 88–89% of the spare power.
> - **Settlement:** a bill becomes final once its evidence goes quiet; evidence after that becomes
>   a correction, never a silent edit. Checked while gateways are being killed.
> - **Reconnect storms:** 2,000 simulated chargers all come back after one gateway, or all three,
>   are killed, measured from the chargers' side: as processes, and now as pods in Kubernetes.
>
> See [docs/ROADMAP.md](docs/ROADMAP.md). To learn how it was built, start with
> [docs/BUILD_JOURNAL.md](docs/BUILD_JOURNAL.md).

## What we're setting out to prove

Each result gets a write-up in `docs/results/` with the exact command, seed, date and raw numbers.

1. **Billing:** zero discrepancies across 5,000 simulated sessions with injected faults (offline
   periods, duplicate messages, out-of-order meter values, meter resets, gateway pod kills).
   _Done: 5,000 sessions inside Kubernetes with gateway pods crashed, deleted and drained, six
   runs, zero discrepancies ([write-up](docs/results/m4-billing-with-pod-kills.md)). Before that,
   with processes ([write-up](docs/results/m3-billing-with-gateway-kills.md))._
2. **Smart charging:** no site exceeds its power cap across 1,000 simulated load changes.
   _So far: 1,000 load changes with charger faults and controller restarts, outside Kubernetes;
   the cap held in every run ([write-up](docs/results/m3-smart-charging-cap.md)). In Kubernetes,
   with pods killed: Milestone 5._
3. **Recovery:** 2,000 simulated chargers reconnect after a gateway pod restart in Kubernetes
   (kind), measured from the chargers' side.
   _So far: with gateway processes, every charger came back in every run
   ([write-up](docs/results/m3-reconnect-storm.md)). In Kubernetes, single runs of each way of
   killing a pod all recovered, and the gateways rebalanced
   ([write-up](docs/results/m4-kind-trial-and-rebalancing.md)). The measured result, with several
   runs per scenario, comes in Milestone 5._

## Prerequisites

| What                  | Why                                          | Where to get it                                                                                             |
| --------------------- | -------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| Node.js 24            | runs everything                              | https://nodejs.org (LTS)                                                                                    |
| pnpm                  | installs and runs the workspace              | `brew install pnpm`                                                                                         |
| Docker Desktop        | Postgres and Redis for development and tests | https://www.docker.com/products/docker-desktop/                                                             |
| OCPP 1.6 JSON schemas | message validation                           | Open Charge Alliance; steps in [packages/ocpp/schemas/v1.6/README.md](packages/ocpp/schemas/v1.6/README.md) |
| kind                  | local Kubernetes (`pnpm kind:up`)            | `brew install kind`                                                                                         |
| kubectl               | talks to kind                                | `brew install kubectl`                                                                                      |

`node scripts/prereqs.ts` checks all of these, works before anything is installed, and says what's
missing.

## Quick start

```bash
pnpm install
pnpm prereqs
pnpm db:up
pnpm db:migrate
pnpm check
pnpm test:integration
pnpm smoke
```

- `pnpm prereqs`: what this machine is missing. (Not `pnpm doctor`: that's pnpm's own built-in
  health check, and it takes precedence over any script with the same name.)
- `pnpm db:up`: TimescaleDB and Redis in Docker.
- `pnpm db:migrate`: creates the tables.
- `pnpm check`: type-check, lint, formatting, and unit tests.
- `pnpm test:integration`: tests against the real database and Redis, including the end-to-end
  session.
- `pnpm smoke`: starts the real gateway, runs one simulated session through it, and checks the
  bill.

## Billing under faults

```bash
pnpm faults --sessions 500 --chargers 50 --seed 1
pnpm faults --sessions 5000 --chargers 100 --gateways 3 --chaos --seed 1
```

The first runs one gateway inside the test process. The second starts three gateway processes and
kills one with SIGKILL every 0.5 to 1.5 seconds while the chargers run (D-029). Add
`--settle-quiet 0` to settle every session the moment its evidence stops, while the chargers still
run: evidence that comes later must then arrive as a correction (D-034).

This runs simulated chargers that misbehave (D-025) against real gateways, then checks every
session: billed exactly what its readings prove, stored once, and rebuilt identically by replaying
its recorded frames into an empty database. The same seed always produces the same faults. If a
run fails, its database schema is kept and the output prints the command to replay the failing
charger:

```bash
pnpm replay --schema <kept schema> --charger <chargePointId>
```

## Smart charging

```bash
pnpm cap --changes 1000 --seed 1
pnpm cap --changes 1000 --seed 1 --gap 150-450
pnpm cap --changes 1000 --seed 1 --restart-every 5000
```

Each command runs 20 simulated chargers, a real gateway and the charging controller (D-032) for
one site with a 150 kW cap, while cars arrive and leave 1,000 times. The chargers refuse some
limits, lose some answers, and drop offline for 0.5 to 2.5 s, often longer than their 1.5 s
lease. Each charger records the limits it really applies. The run passes if their total never
went over the cap, and every connector reached its fair target once the faults stopped.

It also prints usefulness: the share of the spare power the chargers were allowed to use (D-016).
The default pace, a change every 10 to 40 ms, is a stress test: faster than the controller's
50 ms tick. `--gap 150-450` is a fairer pace for usefulness. `--restart-every` restarts the
controller every so many milliseconds, and it forgets everything each time.

## Reconnect storms

```bash
pnpm storm --chargers 2000 --gateways 3 --kill one --down 1000 --seed 1
pnpm storm --chargers 2000 --gateways 3 --kill all --down 2000 --seed 1
```

Each command starts three gateway processes and 2,000 idle chargers at once, kills one gateway
(or all of them) with SIGKILL, and starts it again after the given milliseconds. Every charger
measures how long it took to be accepted again, and the run checks that the chargers that noticed
the outage are exactly the ones the registry had on the killed gateways (D-035). Add `--no-jitter`
for the baseline where every charger backs off in step.

## Kubernetes (kind)

```bash
pnpm kind:up
pnpm kind:faults --sessions 5000 --chargers 100 --chaos --seed 1
pnpm kind:storm --chargers 2000 --gateways 1 --kill none --hold 30000 --seed 1
pnpm kind:storm --chargers 2000 --kill one --kill-mode crash --hold 15000 --seed 1
pnpm kind:down
```

`pnpm kind:up` brings the whole system up in a local Kubernetes cluster: it creates the kind
cluster if needed, builds one image for every service (`deploy/Dockerfile`), loads the images, starts
Postgres and Redis, runs the migrations, starts three gateways, the API, the charging controller and
the settlement CronJob (`deploy/k8s/`), and waits until all are ready (D-036). It is safe to run
again; the services restart only when the image changed.

`pnpm kind:faults` and `pnpm kind:storm` run the same harnesses as `pnpm faults` and `pnpm storm`,
but as a Job inside the cluster: the chargers reach the gateways through their Service, and
`--chaos` (or `--kill`) kills real gateway pods: SIGKILL inside the container, a pod deleted at
once, or a pod drained as a deploy would (D-040). The report is saved under `.runs/` on the laptop.
Measurements never go through `kubectl port-forward`. `--gateways N` (storms only) runs with N
gateway pods, then scales back to 3.

The gateways drain their connections gradually when stopped (D-037), answer BootNotification
`Pending` with an appointment when the cluster's boot budget is spent (D-038), and rebalance their
connections after one restarts (D-039).

To try it by hand: `curl http://localhost:19230/chargers/CP-DEMO-1` reaches the API, and
`pnpm sim --url ws://localhost:19220/ocpp --charger CP-DEMO-1 --tag TAG-DEMO-1` runs one session
through the gateways. If your `kubectl` is far older than the cluster (Docker Desktop ships its own),
set `KUBECTL=/path/to/kubectl`.

## Running it by hand

```bash
pnpm db:seed
pnpm gateway
pnpm api
pnpm sim --charger CP-DEMO-1 --tag TAG-DEMO-1 --seed 42
```

`db:seed` registers the demo site, chargers and id tag. `pnpm controller` keeps the demo site
under its cap (one controller per site; `SITE_ID` picks another). `pnpm settle` settles stopped
sessions whose evidence has been quiet for 15 minutes (`SETTLE_QUIET_MS`), every minute, or once
with `--once`. The gateway listens on
`ws://localhost:9220/ocpp/{chargePointId}`; set `PORT`, `HEARTBEAT_INTERVAL_S` or `LOG_LEVEL` to
change it. Run `pnpm sim` in a second terminal: it prints the charger's ground truth, including
`physicalWh` and `evidencedWh`, which you can compare with `energy_wh` in the `transactions`
table. Copy `.env.example` to `.env` to point everything at a different database or Redis.

The API listens on `http://localhost:9230`:

| Request                                 | What it does                                                                                                                                                             |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `GET /chargers/{id}`                    | The charger's details, which gateway holds it, and its connectors' live status                                                                                           |
| `GET /chargers/{id}/sessions`           | Its last 50 sessions, with their bills                                                                                                                                   |
| `GET /sessions/{transactionId}`         | One session, its bill, and any corrections made after it settled (D-034)                                                                                                 |
| `POST /chargers/{id}/commands/{action}` | Sends any OCPP command the backend may send (body: the payload), through whichever gateway holds the charger (D-030). Charging limits are left to the controller (D-032) |

## Layout

```
voltline/
├── DECISIONS.md              design decisions and why: read before any interview
├── docs/ROADMAP.md           milestones and their exit checks
├── docker-compose.yml        TimescaleDB + Redis, pinned versions
├── packages/
│   ├── availability/         live connector status in Redis, newest report wins
│   ├── billing/              sessions: idempotent ingestion, exact energy in Wh, authorization
│   ├── common/               seeded PRNG with named streams, injectable clock
│   ├── db/                   SQL migrations, migration runner, per-test databases, demo seed
│   ├── ocpp/                 OCPP-J framing, the official 1.6 schemas, validation, generated types
│   ├── routing/              which gateway holds each charger; commands over Redis pub/sub
│   └── smart-charging/       fair power targets and a cap-safe controller step (pure functions)
├── services/
│   ├── api/                  REST: chargers, sessions and bills, commands to chargers
│   ├── charging-controller/  keeps each site under its power cap with leased limits
│   ├── gateway/              the OCPP 1.6J WebSocket server, its handlers and frame log
│   └── settlement/           settles stopped sessions once their evidence goes quiet
├── simulator/                seeded chargers that misbehave and record their own ground truth
├── tests/e2e/                end-to-end tests and harnesses: pnpm faults / cap / storm / replay
├── deploy/                   Dockerfile, the kind cluster config, and the Kubernetes manifests
└── scripts/                  prereqs.ts (machine check), smoke.ts (run it for real), kind/ (pnpm kind:*)
```

## Conventions

- **Energy is integer watt-hours**, `bigint` in Postgres, never a float (D-007).
- **Every random choice comes from a seed.** Use `Prng` from `@voltline/common`; `Math.random`
  fails lint (D-011). Property tests print their seed when they fail; replay with
  `VOLTLINE_SEED=<seed> pnpm test`.
- **Tests sit next to the code.** `*.test.ts` needs nothing running; `*.int.test.ts` and
  `tests/e2e` need `pnpm db:up`.
- **Every decision worth defending goes in [DECISIONS.md](DECISIONS.md)**, and code points to it
  by number.
- **Don't edit the vendored OCPP schemas.** Work around problems in code and record why. After
  updating them, regenerate the payload types with `pnpm ocpp:types`.
