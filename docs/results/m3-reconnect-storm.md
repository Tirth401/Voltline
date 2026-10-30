# Milestone 3: 2,000 chargers reconnect after gateways are killed

**Result.** 2,000 idle simulated chargers on three real gateway processes, on one laptop. Six
runs: three that kill one gateway for 1 s, and three that kill all three gateways for 2 s, each
with SIGKILL. In every run, every charger that lost its connection noticed, came back, and was
accepted by a gateway again. None gave up. After killing all three gateways, the last charger was
back about 2 s after the gateways were, which is the backoff cap.

This is the simulator side of the third headline goal. The goal itself, a gateway _pod_ restart
in Kubernetes, comes in Milestone 5.

## How to reproduce

```bash
pnpm db:up
pnpm db:migrate
pnpm storm --chargers 2000 --gateways 3 --kill one --down 1000 --seed 1
pnpm storm --chargers 2000 --gateways 3 --kill all --down 2000 --seed 1
pnpm storm --chargers 2000 --gateways 3 --kill all --down 2000 --seed 1 --no-jitter
```

Seeds 2 and 3 are the same commands with `--seed 2` and `--seed 3`. Each run saves its full
report, including the 100 ms curve, under `.runs/`.

## Setup

- **Date:** 2026-10-30 (UTC).
- **Machine:** Apple Silicon (arm64), 10 cores, 16 GB RAM. Docker Desktop with 7.8 GiB for
  containers.
- **Software:** Node 24.15.0, TimescaleDB 2.31.0 on PostgreSQL 17, Redis 8.10.3.
- **Gateways:** three gateway processes on this machine, sharing one Postgres schema and one Redis
  prefix.
- **Chargers:** 2,000 `IdleCharger`s in the test process (D-035). Each connection attempt picks a
  gateway at random, as a load balancer would. Between failed attempts a charger waits a random
  time between 0 and 50 ms × 2^attempt, capped at 2 s (D-028). Every message is checked against
  the official schemas in both directions.
- **The storm:** every charger is started at the same moment and accepted ("cold start"). Then
  either the first gateway or all three are killed with SIGKILL, and started again after 1 s or
  2 s.
- **Measured per charger:** from noticing the lost connection to a gateway accepting its
  BootNotification again.

## Cold start (every run)

All 2,000 chargers were started at the same moment. In every run, all of them were accepted
within 477 to 552 ms.

## One gateway killed for 1 s

| Seed | Chargers that lost the connection (registry said) | Back | Gave up | p50    | p95    | p99      | Max      | Most attempts | Gateway listening again | Last charger back |
| ---- | ------------------------------------------------- | ---- | ------- | ------ | ------ | -------- | -------- | ------------- | ----------------------- | ----------------- |
| 1    | 667 (667)                                         | 667  | 0       | 129 ms | 247 ms | 586 ms   | 2,164 ms | 7             | 1,233 ms                | 2,179 ms          |
| 2    | 642 (642)                                         | 642  | 0       | 316 ms | 362 ms | 615 ms   | 1,139 ms | 5             | 1,194 ms                | 1,204 ms          |
| 3    | 686 (686)                                         | 686  | 0       | 131 ms | 229 ms | 1,072 ms | 2,055 ms | 7             | 1,214 ms                | 2,094 ms          |

## All three gateways killed for 2 s

| Seed | Chargers that lost the connection (registry said) | Back  | Gave up | p50      | p95      | p99      | Max      | Most attempts | Gateways listening again | Last charger back |
| ---- | ------------------------------------------------- | ----- | ------- | -------- | -------- | -------- | -------- | ------------- | ------------------------ | ----------------- |
| 1    | 2,000 (2,000)                                     | 2,000 | 0       | 2,809 ms | 3,773 ms | 4,017 ms | 4,184 ms | 11            | 2,280 ms                 | 4,262 ms          |
| 2    | 2,000 (2,000)                                     | 2,000 | 0       | 2,808 ms | 3,862 ms | 4,075 ms | 4,230 ms | 12            | 2,309 ms                 | 4,296 ms          |
| 3    | 2,000 (2,000)                                     | 2,000 | 0       | 2,823 ms | 3,801 ms | 4,042 ms | 4,214 ms | 11            | 2,300 ms                 | 4,255 ms          |

Times in the last two columns are from the moment of the kill.

How the chargers came back in seed 1, counting connected chargers after the kill:

| After the kill | 2.6 s | 3.1 s | 3.6 s | 4.1 s | 4.3 s |
| -------------- | ----- | ----- | ----- | ----- | ----- |
| Connected      | 682   | 1,317 | 1,793 | 1,992 | 2,000 |

## The same full outage without jitter (a baseline)

With `--no-jitter`, every charger waits the full backoff each time (100, 200, 400, 800, 1,600 ms),
so all of them retry at the same moments.

| Seed | Back  | p50      | p95      | p99      | Max      | Attempts (every charger) | Gateways listening again | Last charger back |
| ---- | ----- | -------- | -------- | -------- | -------- | ------------------------ | ------------------------ | ----------------- |
| 1    | 2,000 | 3,523 ms | 3,549 ms | 3,556 ms | 3,558 ms | 6                        | 2,223 ms                 | 3,620 ms          |
| 2    | 2,000 | 3,614 ms | 3,653 ms | 3,657 ms | 3,666 ms | 6                        | 2,279 ms                 | 3,696 ms          |

In seed 1, no charger was connected until 3.1 s after the kill, when all 2,000 tried again in the
same instant. All of them were back half a second later.

## Reading the numbers

- **The registry agreed every time.** The chargers that noticed a lost connection were exactly the
  ones the registry had placed on the killed gateways: 667, 642 and 686, or all 2,000. So no
  charger silently missed the outage, and none is missing from the numbers.
- **One gateway down: most chargers are back within a few hundred milliseconds** (p50 129 to
  316 ms, p95 229 to 362 ms). They pick a surviving gateway on their first or second try. The
  tail, up to about 2 s, is chargers that kept picking the dead gateway by chance and backed off
  each time.
- **All gateways down: the last charger is back about one backoff cap after the gateways.** The
  gateways listened again after about 2.3 s (2 s down, plus starting Node). The last charger was
  back about 2 s later, because a charger that has just started a 2 s wait sits it out. A shorter
  cap would recover faster, but chargers would hammer the gateways harder while they are down.
- **Without jitter, recovery was faster here, as one big wave.** All 2,000 chargers tried again
  at 3.1 s, and the gateways accepted them all within half a second, just as at the cold start.
  So the last charger was back about 0.6 s sooner than with jitter. Jitter spread the same
  reconnects over about 2 s instead. Its value is not speed: it is protection when a wave is
  bigger than the gateways can take. Then chargers in step fail together and retry together, again
  and again. These gateways had capacity to spare, so here jitter only cost time. Milestone 5
  measures this again with BootNotification rate limiting, which makes the capacity limit real.
- **Nothing rebalances afterwards.** When one gateway is killed and restarted, almost nobody goes
  back to it: in seed 3 it ended with 3 chargers, while the other two had about 1,000 each.

## Limits

- Everything ran on one laptop, chargers and gateways sharing the CPU.
- SIGKILL makes the kernel reset the sockets at once, so a charger notices the loss straight
  away. Across a real network that can take until a ping times out (D-026), so these times are a
  lower bound.
- The backoff cap is 2 s. Real chargers often wait longer between tries.
- These are process kills, not Kubernetes pod restarts behind a Service. That is Milestone 5.
