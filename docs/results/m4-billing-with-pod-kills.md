# Milestone 4: billing while Kubernetes pods are killed

**Result.** Six runs of 5,000 seeded sessions on 100 simulated chargers, inside a Kubernetes
cluster (kind), against three gateway pods behind a Service. The fifth ran on a cluster brought up
from nothing with `pnpm kind:up`, which took 72 seconds. While the chargers ran, a seeded chaos
driver inside the cluster killed a gateway pod every few seconds, in three ways: SIGKILL inside the
container, the pod deleted at once, or the pod drained as a deploy would. In every run, every
session was billed exactly its evidenced energy, none was lost or invented, and every bill was
rebuilt by replaying the recorded frames.

This is the first headline goal in its final setting: zero billing discrepancies across 5,000
sessions with injected faults and gateway pod kills. It is also the Milestone 4 exit check: one
script brings the whole system up in kind (`pnpm kind:up`), and result 1 reproduces there with real
pod kills.

The first four official runs did not all pass: two of them found a bug in the simulator. That batch
is reported below too.

## How to reproduce

```bash
pnpm kind:down    # optional: start from no cluster at all
pnpm kind:up
pnpm kind:faults --sessions 5000 --chargers 100 --chaos --seed 1
```

Seeds 2 and 3 are the same command with `--seed 2` and `--seed 3`. `pnpm kind:faults` starts the
run as a Job inside the cluster, prints its log, and saves the full report under `.runs/` as
`kind-faults-seed<N>-<time>.json`.

## Setup

- **Date:** 2026-10-30 (UTC).
- **Machine:** Apple Silicon (arm64), 10 cores, 16 GB RAM. Docker Desktop with 7.8 GiB for
  containers.
- **Software:** Node 24.15.0, Kubernetes 1.37.0 in kind 0.33.0 (one node), TimescaleDB 2.31.0 on
  PostgreSQL 17, Redis 8.10.3.
- **The system, as `pnpm kind:up` deploys it** (D-036): three gateway pods behind one Service,
  Postgres and Redis as StatefulSets, the API, the charging controller and the settlement CronJob.
  The gateways drain gradually when stopped (D-037), share a boot budget of 500 a second (D-038),
  and rebalance their connections (D-039).
- **The chargers:** 100 simulated chargers, 50 sessions each, in a Job inside the cluster
  (D-040). They connect to `ws://gateway:9220/ocpp`, and the Service picks a ready pod for each new
  connection. Every run starts from a clean slate in the cluster's database.
- **Chaos:** every 0.5 to 1.5 s, if at least two gateways are ready, one of the ready gateways is
  killed in one of three ways, picked by the seed with equal chances:
  - **crash:** `kill -KILL -1` inside the container. Node gets no chance to close a socket or finish
    a write. Kubernetes restarts the container in the same pod;
  - **delete:** the pod is deleted with no grace period, and a new pod replaces it;
  - **drain:** the pod is deleted politely: a 5 s pause, SIGTERM, and its connections closed one by
    one over 10 s.
- **Charger faults:** the same `DEFAULT_FAULTS` profile as Milestones 2 and 3.

## Faults and crashes (the final runs)

| Run           | Offline spells | Late starts | Shuffled queues | Readings after stop | Meter resets | Unreported | Lost answers | Dropped mid-message | Pod kills: crash / delete / drain | Skipped (one ready) | Reconnects |
| ------------- | -------------- | ----------- | --------------- | ------------------- | ------------ | ---------- | ------------ | ------------------- | --------------------------------- | ------------------- | ---------- |
| seed 1        | 1,477          | 517         | 716             | 71                  | 997          | 494        | 6,433        | 2,597               | 11: 5 / 3 / 3                     | 5                   | 191        |
| seed 2        | 1,490          | 493         | 742             | 65                  | 1,039        | 508        | 6,445        | 2,717               | 11: 4 / 2 / 5                     | 4                   | 197        |
| seed 3        | 1,435          | 479         | 726             | 60                  | 951          | 484        | 6,365        | 2,696               | 13: 4 / 5 / 4                     | 8                   | 191        |
| seed 1, rerun | 1,477          | 517         | 716             | 71                  | 997          | 494        | 6,433        | 2,597               | 9: 4 / 4 / 1                      | 8                   | 128        |
| seed 1, fresh | 1,477          | 517         | 716             | 71                  | 997          | 494        | 6,433        | 2,597               | 8: 4 / 3 / 1                      | 7                   | 125        |
| seed 2, last  | 1,490          | 493         | 742             | 65                  | 1,039        | 508        | 6,445        | 2,717               | 13: 6 / 3 / 4                     | 4                   | 178        |

"Fresh": the cluster was deleted (`pnpm kind:down`) and brought up again from nothing
(`pnpm kind:up`, 72 s) just before it. "Last": one more change came after the other runs (on
shutdown, a gateway now waits at most a second for Redis before it drains, so a Redis outage can't
delay a deploy), and this run was made on that, the final code. "Skipped" counts the chaos rounds when only one gateway was ready, so nothing was killed.
"Reconnects" counts the times a charger's connection broke or was closed under it, and it connected
again. No BootNotification was answered Pending: 100 chargers boot once each, well inside the
budget.

## Outcome (the final runs)

| Run           | Sessions in database | Lost | Invented | Discrepancies | Replay mismatches | Wh flowed  | Wh evidenced | Wh billed  | Time   |
| ------------- | -------------------- | ---- | -------- | ------------- | ----------------- | ---------- | ------------ | ---------- | ------ |
| seed 1        | 5,000                | 0    | 0        | 0             | 0                 | 15,996,933 | 15,954,825   | 15,954,825 | 23.8 s |
| seed 2        | 5,000                | 0    | 0        | 0             | 0                 | 16,545,189 | 16,499,037   | 16,499,037 | 20.7 s |
| seed 3        | 5,000                | 0    | 0        | 0             | 0                 | 16,139,927 | 16,097,514   | 16,097,514 | 22.9 s |
| seed 1, rerun | 5,000                | 0    | 0        | 0             | 0                 | 15,996,933 | 15,954,825   | 15,954,825 | 20.4 s |
| seed 1, fresh | 5,000                | 0    | 0        | 0             | 0                 | 15,996,933 | 15,954,825   | 15,954,825 | 18.8 s |
| seed 2, last  | 5,000                | 0    | 0        | 0             | 0                 | 16,545,189 | 16,499,037   | 16,499,037 | 22.7 s |

As before, every session was also checked for three more things: it was stored under the
transactionId the charger was given; every reading was stored exactly once; and all copies of its
StartTransaction got the same id. None of these checks failed. "Time" is how long the chargers took
to finish, on this laptop.

## Reading the numbers

- **Same seed, same scenario, new infrastructure.** Every fault count and every energy total above
  is exactly the same as in the Milestone 3 runs with processes
  ([m3-billing-with-gateway-kills.md](m3-billing-with-gateway-kills.md)). The chargers' behaviour
  depends only on the seed (D-028); only the crashes, their timing and the reconnects changed. So
  the two milestones billed the same 5,000 sessions per seed, through different infrastructure, to
  the same watt-hour.
- **The kills were real and varied.** Each run had 8 to 13 pod kills, of all three kinds. Most kills
  happened with only two gateways ready (the third still coming back), and 4 to 8 rounds per run
  found only one gateway ready and killed nothing. So the chargers often had a single gateway to
  go to.
- **Fewer reconnects than in Milestone 3** (125 to 197, against 377 to 421). The Service only sends
  new connections to ready pods, while in Milestone 3 each charger picked any of three addresses at
  random, dead or alive.
- **"0 discrepancies" means billed equals evidenced** (D-010). The gap between flowed and evidenced
  is energy hidden by unreported meter resets, which no backend could prove.

## Settlement while pods are killed

One more run on the final code, with settlement running all the time and no quiet period (D-034):
every session settles the moment its evidence stops, and evidence that comes later must arrive as a
correction.

```bash
pnpm kind:faults --sessions 5000 --chargers 100 --chaos --seed 1 --settle-quiet 0
```

| Run                | Pod kills: crash / delete / drain | Reconnects | Settled while running / at the end | Corrections | Sessions corrected | Correction total | Discrepancies | Lost | Invented | Replay mismatches |
| ------------------ | --------------------------------- | ---------- | ---------------------------------- | ----------- | ------------------ | ---------------- | ------------- | ---- | -------- | ----------------- |
| seed 1, quiet 0 ms | 9: 4 / 4 / 1                      | 222        | 5,000 / 0                          | 7           | 4                  | +5,375 Wh        | 0             | 0    | 0        | 0                 |

Every session settled, and every settled bill plus its corrections equalled its bill. The 7
corrections on 4 sessions, +5,375 Wh, are exactly the numbers of the Milestone 3 run with processes
([m3-settlement-corrections.md](m3-settlement-corrections.md)).

## Every run, including the ones that failed

### The first official batch: two runs found a bug

| Run           | Kills: crash / delete / drain | Chargers that gave up | Sessions that finished | Discrepancies among them | Replay mismatches |
| ------------- | ----------------------------- | --------------------- | ---------------------- | ------------------------ | ----------------- |
| seed 1        | 10: 5 / 2 / 3                 | 0                     | 5,000                  | 0                        | 0                 |
| seed 2        | 9: 3 / 3 / 3                  | 99                    | 50                     | 0                        | 0                 |
| seed 3        | 12: 3 / 6 / 3                 | 0                     | 5,000                  | 0                        | 0                 |
| seed 1, rerun | 7: 3 / 3 / 1                  | 93                    | 350                    | 0                        | 0                 |

The two failed runs failed in the simulator, not in billing. Each charger that gave up had been
turned away with HTTP 503 and treated that as permanent: in earlier milestones, the gateway only
refused a charger it didn't know (404) or one that didn't speak OCPP 1.6 (400), and retrying could
never help. Since this milestone, a gateway that is draining (D-037) or holds more than its share
(D-039) answers 503, which means "try another gateway". Seeds 1 and 3 passed only because no
charger happened to reach a draining gateway. Every session that did finish was billed exactly, and
the replay of everything recorded, finished or not (1,701 and 2,834 sessions), matched.

The fix: the simulator now retries after a 503 like after any other failed connection, with
backoff (D-028); other refusals stay permanent. A new integration test puts a "gateway" that turns
every charger away with 503 next to a real one; it fails without the fix and passes with it. Then
all four runs were done again: the first four final runs above.

### Development runs, before the final code

| When (UTC) | Command                                                     | Outcome                                                                                                                                      |
| ---------- | ----------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| 19:25      | `pnpm kind:faults --sessions 500 --chargers 50 --seed 1`    | passed, no kills: the same faults as the Milestone 2 seed-1 run (132 offline spells, 683 lost answers) and 1,623,762 Wh evidenced and billed |
| 19:25      | `pnpm kind:faults --sessions 1000 --chargers 100 --chaos …` | stopped with no report: the chaos driver's API call got "400 Bad Request" after its first pod delete (fixed: D-036)                          |
| 19:26      | the same                                                    | passed: 3 kills (2 crash, 1 delete), 48 reconnects                                                                                           |
| 19:27      | `pnpm kind:faults --sessions 5000 --chargers 100 --chaos …` | passed: 9 kills (6 crash, 3 delete; draining wasn't a kill mode yet), 224 reconnects, 15,954,825 Wh evidenced and billed, 19.1 s             |

Those runs used earlier code: no boot budget, no rebalancing, no drain mode.

## What had to change for this to work

1. **The whole deployment** (D-036): one image, manifests, probes, and `pnpm kind:up`.
2. **The simulator and the chaos driver run inside the cluster** (D-040), with a narrow Role.
3. **A fresh connection for each Kubernetes API call**, after a reused one got "400 Bad Request".
4. **The simulator retries after a 503**, found by the first official batch.
5. **A gateway shutting down waits at most a second for Redis** before it drains, so a Redis outage
   can't hold up a deploy (D-037). This came last; the run marked "last" used it.
6. **A failing connection is noticed at once.** The simulated charger's client used to send into a
   socket the gateway had already closed, and wait out its 10 s timeout; draining and rebalancing
   close idle connections on purpose, so the client now fails at once and the charger reconnects.

## Limitations

- **One node.** Chargers, gateways and the database share one laptop, and no node fails. A crashed
  container restarts on the same machine.
- **Only gateways are killed.** Postgres and Redis stay up, with one replica each.
- **No network partitions:** a gateway is either up or killed.
- **The chaos driver's own timing varies:** waiting for each crash to show up in the API stretches
  the time between kills, so kills came every 1.5 to 3 s rather than every 0.5 to 1.5 s.
- **Time is virtual and compressed,** as in earlier milestones: the time column is one run's
  wall-clock time on this laptop, not a benchmark.
