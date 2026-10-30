# Milestone 2: billing under faults, one gateway

**Result.** Three runs of 500 seeded sessions each. Simulated chargers went offline, sent
StartTransaction late, lost answers, hung up mid-message, sent their queues shuffled, and had their
meters reset. In every run, every session was billed exactly its evidenced energy, none was lost
and none was invented, and every bill was reproduced by replaying the recorded frames into an
empty database.

## How to reproduce

```bash
pnpm db:up
pnpm db:migrate
pnpm faults --sessions 500 --chargers 50 --seed 1
```

Seeds 2 and 3 are the same command with `--seed 2` and `--seed 3`. Each run saves its full report,
including any per-session problems, under `.runs/`.

## Setup

- **Date:** 2026-10-29.
- **Machine:** Apple Silicon (arm64), 10 cores, 16 GB RAM. Docker Desktop with 7.8 GiB for
  containers.
- **Software:** Node 24.15.0, TimescaleDB 2.31.0 on PostgreSQL 17, Redis 8.10.3.
- **Topology:** one gateway in the same process as the 50 simulated chargers, with Postgres and
  Redis in Docker. Each charger ran 10 sessions back to back.
- **Fault profile (`DEFAULT_FAULTS`):**
  - offline spell: 0.3 per session, a third of them starting before the session does;
  - lost answer: 0.05 per message;
  - connection dropped right after sending: 0.02 per message;
  - shuffled queue: 0.5 per offline spell;
  - meter reset: 0.2 per session, half of them unreported.

## Faults injected (every run)

| Seed     | Offline spells | Late StartTransactions | Shuffled queues | Readings after the stop | Meter resets | Unreported resets | Lost answers | Dropped mid-message |
| -------- | -------------- | ---------------------- | --------------- | ----------------------- | ------------ | ----------------- | ------------ | ------------------- |
| 1        | 132            | 41                     | 70              | 8                       | 99           | 46                | 683          | 279                 |
| 1, rerun | 132            | 41                     | 70              | 8                       | 99           | 46                | 683          | 279                 |
| 2        | 153            | 47                     | 80              | 6                       | 99           | 45                | 656          | 256                 |
| 3        | 143            | 52                     | 76              | 6                       | 100          | 53                | 628          | 241                 |

Lost answers and dropped connections are counted per message. The other columns count sessions.

## Outcome (every run)

| Seed     | Sessions in database | Lost | Invented | Discrepancies | Replay mismatches | Wh flowed | Wh evidenced | Wh billed | Time  |
| -------- | -------------------- | ---- | -------- | ------------- | ----------------- | --------- | ------------ | --------- | ----- |
| 1        | 500                  | 0    | 0        | 0             | 0                 | 1,627,276 | 1,623,762    | 1,623,762 | 3.5 s |
| 1, rerun | 500                  | 0    | 0        | 0             | 0                 | 1,627,276 | 1,623,762    | 1,623,762 | 3.4 s |
| 2        | 500                  | 0    | 0        | 0             | 0                 | 1,606,034 | 1,602,468    | 1,602,468 | 3.8 s |
| 3        | 500                  | 0    | 0        | 0             | 0                 | 1,582,749 | 1,577,563    | 1,577,563 | 3.5 s |

Every session was also checked for three more things:

- it was stored under the transactionId the charger was given;
- every reading the charger sent was stored exactly once;
- all copies of its StartTransaction got the same id.

None of these checks failed in any run.

## Reading the numbers

- **"0 discrepancies" means billed equals evidenced** (DECISIONS.md D-010): what the readings the
  charger sent can prove. It does not mean billed equals flowed.
- **The gap between flowed and evidenced** is 3,514 Wh, 3,566 Wh and 5,186 Wh in the three
  seeds. That is energy hidden by unreported meter resets. No backend could prove it, so billing
  correctly leaves it out: it undercharges in those sessions and never overcharges.
- **Rerunning seed 1 reproduced every count and total exactly.** Only the time changed. A seed
  fixes the scenario, not the network's interleaving (D-011). The bills matched regardless, which
  is the point.

## Limitations

- **One gateway, and it never crashes.** Gateway process kills come in Milestone 3 and pod kills in
  kind in Milestone 4. The 5,000-session target with pod kills is not claimed yet.
- **The faults follow our model of an OCPP 1.6 charger:** an outbox that resends until it gets an
  answer (D-025). Real firmware varies; interoperability with SAP's simulator comes in Milestone 5.
  Not modelled yet: charger clock jumps, and chargers that give up on a message for good.
- **The late-reading path is rare in this mix.** Readings delivered after their session's stop
  happened in only 6 to 8 sessions per run. A dedicated test races a stop against a late reading
  20 times to cover that path directly.
- **Time is virtual.** Each charger's minutes pass instantly. The time column is one run's
  wall-clock time on this laptop, not a performance benchmark.
