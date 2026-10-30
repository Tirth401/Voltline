# Milestone 3: billing while gateways crash

**Result.** Three runs of 5,000 seeded sessions on 100 simulated chargers, against three gateway
processes. While the chargers ran, a seeded "chaos" loop killed a gateway with SIGKILL every
0.5 to 1.5 seconds. In every run, every session was billed exactly its evidenced energy, none was
lost or invented, and every bill was rebuilt by replaying the recorded frames.

This is the first headline goal (zero billing discrepancies across 5,000 sessions with faults and
server kills), with one difference: the servers are processes on one machine, not pods in
Kubernetes. Pod kills in kind come in Milestone 4.

## How to reproduce

```bash
pnpm db:up
pnpm db:migrate
pnpm faults --sessions 5000 --chargers 100 --gateways 3 --chaos --seed 1
```

Seeds 2 and 3 are the same command with `--seed 2` and `--seed 3`. Each run saves its full report
under `.runs/`.

## Setup

- **Date:** 2026-10-30 (UTC).
- **Machine:** Apple Silicon (arm64), 10 cores, 16 GB RAM. Docker Desktop with 7.8 GiB for
  containers.
- **Software:** Node 24.15.0, TimescaleDB 2.31.0 on PostgreSQL 17, Redis 8.10.3.
- **Topology:**
  - three gateway processes on this machine, sharing one Postgres schema and one Redis prefix;
  - 100 simulated chargers in the test process, 50 sessions each;
  - each new connection picks a gateway at random, the way a load balancer would spread them.
- **Chaos:** every 0.5 to 1.5 s, one running gateway is killed with SIGKILL and restarted 0.2 to
  1 s later. SIGKILL gives the process no chance to close sockets or finish writes. Never more
  than one gateway is down at a time.
- **Charger faults:** the same `DEFAULT_FAULTS` profile as Milestone 2.

## Faults and crashes (every run)

| Run           | Offline spells | Late starts | Shuffled queues | Readings after stop | Meter resets | Unreported | Lost answers | Dropped mid-message | Gateway kills | Reconnects |
| ------------- | -------------- | ----------- | --------------- | ------------------- | ------------ | ---------- | ------------ | ------------------- | ------------- | ---------- |
| seed 1        | 1,477          | 517         | 716             | 71                  | 997          | 494        | 6,433        | 2,597               | 12            | 377        |
| seed 1, rerun | 1,477          | 517         | 716             | 71                  | 997          | 494        | 6,433        | 2,597               | 12            | 402        |
| seed 2        | 1,490          | 493         | 742             | 65                  | 1,039        | 508        | 6,445        | 2,717               | 13            | 421        |
| seed 3        | 1,435          | 479         | 726             | 60                  | 951          | 484        | 6,365        | 2,696               | 12            | 392        |

"Reconnects" counts the times a charger's connection broke under it because a gateway died, and
the charger connected again.

## Outcome (every run)

| Run           | Sessions in database | Lost | Invented | Discrepancies | Replay mismatches | Wh flowed  | Wh evidenced | Wh billed  | Time   |
| ------------- | -------------------- | ---- | -------- | ------------- | ----------------- | ---------- | ------------ | ---------- | ------ |
| seed 1        | 5,000                | 0    | 0        | 0             | 0                 | 15,996,933 | 15,954,825   | 15,954,825 | 22.7 s |
| seed 1, rerun | 5,000                | 0    | 0        | 0             | 0                 | 15,996,933 | 15,954,825   | 15,954,825 | 23.8 s |
| seed 2        | 5,000                | 0    | 0        | 0             | 0                 | 16,545,189 | 16,499,037   | 16,499,037 | 24.1 s |
| seed 3        | 5,000                | 0    | 0        | 0             | 0                 | 16,139,927 | 16,097,514   | 16,097,514 | 23.3 s |

As in Milestone 2, every session was also checked for three more things:

- it was stored under the transactionId the charger was given;
- every reading was stored exactly once;
- all copies of its StartTransaction got the same id.

None of these checks failed.

## Reading the numbers

- **The rerun of seed 1 shows what a seed controls.** Every choice the chargers made is identical:
  1,477 offline spells, 6,433 lost answers, 15,954,825 Wh evidenced. What depends on the timing of
  the crashes is different: 377 reconnects the first time, 402 the second. The bills are identical
  both times. Keeping the chargers' network choices on a separate random stream is what makes this
  possible (D-028).
- **"0 discrepancies" means billed equals evidenced** (D-010). The gap between flowed and evidenced
  is 42,108 Wh, 46,152 Wh and 42,413 Wh in the three seeds: energy hidden by unreported meter
  resets, which no backend could prove.
- **Replay still works with crashes.** A gateway now sends its answer only after the frame log has
  stored the message and the answer (D-023). So any message a charger got an answer to is in the
  recording, even if the gateway died a moment later.

## What had to change for this to work

1. **The frame log became a group commit** (D-023). Before, a killed gateway could lose up to
   200 ms of recorded frames, so replay would have failed exactly when it mattered most.
2. **Chargers reconnect with exponential backoff and jitter** (D-028). They try another gateway,
   wait a random time that grows after each failure, and send the unanswered message again.
3. **The gateway reads its schema, Redis prefix and name from the environment**, so a test can
   start several of them against one throwaway database.

## Limitations

- **Processes on one machine, not pods in Kubernetes.** That is Milestone 4.
- **Only gateways crash.** Postgres and Redis stay up; database high availability is out of scope.
- **A gateway is either fully up or dead.** There are no network partitions, slow networks or
  half-dead gateways yet.
- **Late readings are still the rarest fault:** 60 to 71 sessions per run had readings arrive
  after their stop.
- **Time is virtual and compressed.** The time column is one run's wall-clock time on this
  laptop, not a benchmark. The group commit adds a few milliseconds to every answer: the 500-session
  Milestone 2 run went from 3.5 s to 4.8 s.
