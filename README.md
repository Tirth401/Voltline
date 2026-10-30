# Voltline

A simplified EV charging backend (a Charge Station Management System, or CSMS) that talks to
chargers using OCPP 1.6J over WebSockets. It rebuilds the hard core of a real charging network:
billing that stays exact when chargers misbehave, site power caps that are never exceeded, and
fast recovery when the gateway restarts.

> **Status:** Milestone 3 is under way.
>
> - **Billing under crashes:** 5,000 seeded sessions full of faults are billed to the watt-hour
>   while three gateway processes are killed with SIGKILL as they run (three seeds out of three).
> - **Commands:** commands reach a charger through whichever gateway holds its connection.
> - **Smart charging:** the core is done. It shares a site's cap fairly, and changes limits in an order
>   that is safe at every moment (property-tested).
> - **Next:** the controller service that sends limits to chargers, and the simulator's model of
>   how chargers apply them.
>
> See [docs/ROADMAP.md](docs/ROADMAP.md). To learn how it was built, start with
> [docs/BUILD_JOURNAL.md](docs/BUILD_JOURNAL.md).

## What we're setting out to prove

Each result gets a write-up in `docs/results/` with the exact command, seed, date and raw numbers.

1. **Billing:** zero discrepancies across 5,000 simulated sessions with injected faults (offline
   periods, duplicate messages, out-of-order meter values, meter resets, gateway pod kills).
   _So far: 5,000 sessions with gateway processes killed mid-run, three seeds, zero
   discrepancies ([write-up](docs/results/m3-billing-with-gateway-kills.md)). Pod kills in
   Kubernetes come next._
2. **Smart charging:** no site exceeds its power cap across 1,000 simulated load changes.
3. **Recovery:** 2,000 simulated chargers reconnect after a gateway pod restart in Kubernetes
   (kind), measured from the chargers' side.

## Prerequisites

| What                  | Why                                          | Where to get it                                                                                             |
| --------------------- | -------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| Node.js 24            | runs everything                              | https://nodejs.org (LTS)                                                                                    |
| pnpm                  | installs and runs the workspace              | `brew install pnpm`                                                                                         |
| Docker Desktop        | Postgres and Redis for development and tests | https://www.docker.com/products/docker-desktop/                                                             |
| OCPP 1.6 JSON schemas | message validation                           | Open Charge Alliance; steps in [packages/ocpp/schemas/v1.6/README.md](packages/ocpp/schemas/v1.6/README.md) |
| kind                  | local Kubernetes (trial run in week 2)       | `brew install kind`                                                                                         |
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
kills one with SIGKILL every 0.5 to 1.5 seconds while the chargers run (D-029).

This runs simulated chargers that misbehave (D-025) against real gateways, then checks every
session: billed exactly what its readings prove, stored once, and rebuilt identically by replaying
its recorded frames into an empty database. The same seed always produces the same faults. If a
run fails, its database schema is kept and the output prints the command to replay the failing
charger:

```bash
pnpm replay --schema <kept schema> --charger <chargePointId>
```

## Running it by hand

```bash
pnpm db:seed
pnpm gateway
pnpm api
pnpm sim --charger CP-DEMO-1 --tag TAG-DEMO-1 --seed 42
```

`db:seed` registers the demo chargers and id tag. The gateway listens on
`ws://localhost:9220/ocpp/{chargePointId}`; set `PORT`, `HEARTBEAT_INTERVAL_S` or `LOG_LEVEL` to
change it. Run `pnpm sim` in a second terminal: it prints the charger's ground truth, including
`physicalWh` and `evidencedWh`, which you can compare with `energy_wh` in the `transactions`
table. Copy `.env.example` to `.env` to point everything at a different database or Redis.

The API listens on `http://localhost:9230`:

| Request                                 | What it does                                                                                                         |
| --------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `GET /chargers/{id}`                    | The charger's details, which gateway holds it, and its connectors' live status                                       |
| `GET /chargers/{id}/sessions`           | Its last 50 sessions, with their bills                                                                               |
| `GET /sessions/{transactionId}`         | One session and its bill                                                                                             |
| `POST /chargers/{id}/commands/{action}` | Sends any OCPP command the backend may send (body: the payload), through whichever gateway holds the charger (D-030) |

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
│   └── gateway/              the OCPP 1.6J WebSocket server, its handlers and frame log
├── simulator/                seeded chargers that misbehave and record their own ground truth
├── tests/e2e/                end-to-end tests, the fault and crash harness, pnpm faults / replay
└── scripts/                  prereqs.ts (machine check), smoke.ts (run it for real)
```

Added as the milestones need them: `services/charging-controller` and `deploy/`.

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
