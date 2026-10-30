# Milestone 3: smart charging under a power cap

**Result.** Ten runs of 1,000 load changes on a site of 20 simulated chargers with a 150 kW cap:
five at stress pace, two with the controller restarting every 5 seconds, and three at a calmer
pace. The chargers refused limits, lost answers and dropped offline. In every run, the limits the
chargers actually applied never added up to more than the cap, and every connector reached its
fair target once the faults stopped. At the calmer pace, the chargers were allowed to use 88% to
89% of the spare power.

This is the second headline goal (no site exceeds its power cap across 1,000 simulated load
changes), outside Kubernetes. Running it in kind, with pods killed, comes in Milestone 4.

## How to reproduce

```bash
pnpm db:up
pnpm db:migrate
pnpm cap --changes 1000 --seed 1
pnpm cap --changes 1000 --seed 1 --restart-every 5000
pnpm cap --changes 1000 --seed 1 --gap 150-450
pnpm test:integration
```

Other seeds are the same commands with another `--seed`. Each run saves its full report under
`.runs/`. The integration tests hold the 200-change exit check and the negative controls.

## Setup

- **Date:** 2026-10-30 (UTC).
- **Machine:** Apple Silicon (arm64), 10 cores, 16 GB RAM. Docker Desktop with 7.8 GiB for
  containers.
- **Software:** Node 24.15.0, TimescaleDB 2.31.0 on PostgreSQL 17, Redis 8.10.3.
- **Site:** a 150,000 W cap. 20 chargers with one connector each, a default limit of 4,140 W
  (6 A on three phases at 230 V) and a maximum of 22,000 W. The defaults together take 82,800 W,
  so 67,200 W is spare power to share.
- **System:** one gateway, the command bus over Redis, and the charging controller (D-032). The
  controller ticks every 50 ms and sends 1.5 s leases with a 0.3 s clock allowance. These are the
  production values (1 s, 30 s and 2 s) scaled down, so a lease really runs out during a run. The
  controller runs for one lease before the load starts, like a controller that has been up for a
  while.
- **Load:** cars arrive or leave 1,000 times, one at a time, at a random charger that is online.
  Each change is 10 to 40 ms after the last one (stress pace, faster than the controller's tick)
  or 150 to 450 ms (calm pace). After each change, there is a 5% chance that a random charger
  drops offline for 0.5 to 2.5 s; a lease lasts 1.5 s.
- **Charger faults:** a charger takes 0 to 40 ms to apply a limit and answer, refuses 10% of the
  limits it gets, and 5% of its answers are lost on the way back.
- **Verdict:** each charger records every limit it applies, with a timestamp. The peak is the
  highest total at any moment, with idle connectors counted at their default. After the load, the
  faults stop and the controller gets 3 s to settle; then every connector must be at its fair
  target. The controller's own beliefs play no part.

## Safety (every run)

| Run              | Arrivals / departures | Offline spells | Limits accepted | Refused | Unanswered | Charger already gone | Limit changes applied | Peak (cap 150,000 W) | Settled | Time    |
| ---------------- | --------------------- | -------------- | --------------- | ------- | ---------- | -------------------- | --------------------- | -------------------- | ------- | ------- |
| stress, seed 1   | 505 / 495             | 37             | 1,564           | 380     | 108        | 9                    | 1,958                 | 150,000 W            | yes     | 31.2 s  |
| stress, seed 2   | 506 / 494             | 38             | 1,489           | 370     | 118        | 10                   | 1,872                 | 150,000 W            | yes     | 31.4 s  |
| stress, seed 3   | 506 / 494             | 41             | 1,509           | 378     | 112        | 8                    | 1,877                 | 150,000 W            | yes     | 29.5 s  |
| stress, seed 4   | 504 / 496             | 47             | 1,690           | 384     | 109        | 14                   | 2,130                 | 150,000 W            | yes     | 30.7 s  |
| stress, seed 5   | 504 / 496             | 48             | 1,597           | 326     | 115        | 19                   | 2,024                 | 150,000 W            | yes     | 31.4 s  |
| restarts, seed 1 | 505 / 495             | 37             | 1,233           | 282     | 83         | 1                    | 1,589                 | 150,000 W            | yes     | 31.7 s  |
| restarts, seed 2 | 506 / 494             | 38             | 1,169           | 256     | 93         | 13                   | 1,508                 | 150,000 W            | yes     | 31.7 s  |
| calm, seed 1     | 506 / 494             | 38             | 7,548           | 792     | 419        | 0                    | 8,633                 | 150,000 W            | yes     | 305.3 s |
| calm, seed 2     | 506 / 494             | 44             | 7,650           | 834     | 469        | 0                    | 8,836                 | 150,000 W            | yes     | 305.7 s |
| calm, seed 3     | 508 / 492             | 52             | 7,284           | 842     | 449        | 1                    | 8,454                 | 150,000 W            | yes     | 309.3 s |

No run had an invalid command or a CALLERROR.

## Usefulness

Usefulness (D-016) is the share of the spare power the chargers were allowed to use over the load
changes, out of the most that could have been handed out at each moment. The best case assumes
instant and perfect control of every charger, offline ones included, so 100% can't be reached.

| Pace                       | Seed 1 | Seed 2 | Seed 3 | Seed 4 | Seed 5 |
| -------------------------- | ------ | ------ | ------ | ------ | ------ |
| Stress (10–40 ms)          | 65.0%  | 63.3%  | 64.9%  | 63.3%  | 64.8%  |
| Stress, restarts every 5 s | 53.5%  | 49.9%  |        |        |        |
| Calm (150–450 ms)          | 89.0%  | 88.6%  | 88.0%  |        |        |

## The checks can fail (integration tests)

A check that never fails proves nothing, so the integration tests include two broken
controllers that must fail it:

- **A careless planner:** every target at once, with no ordering and no worst-case budget. On
  the 200-change exit-check scenario (8 chargers, a 60 kW cap, seed 2028), it goes over the cap,
  and the test checks that it does. The safe controller on the same scenario stays within the
  cap, settles, and hands out more than 30% of the spare power even at stress pace.
- **A restart with no waiting period**, in a scripted test. Car A charges alone and gets all the
  spare power: 21,720 W of a 30,000 W cap. A's charger drops offline and keeps that limit. The
  controller restarts, and car B arrives. A controller that trusts its empty memory gives B its
  share (12,930 W) at once: 38,790 W in total, exactly as predicted. With the waiting period, the
  site never goes above 30,000 W.

## Reading the numbers

- **The peak is exactly the cap in every run.** The controller hands out all the spare power, but
  never a watt more. A peak below the cap would have meant power left unused.
- **More refusals than the 10% the chargers draw at random.** A limit can also arrive after its
  session has ended, or during the next session on the same charger. The charger then refuses it,
  as a real one would. At stress pace, sessions start and stop every few hundred milliseconds, so
  this race is common.
- **"Unanswered" is the dangerous case,** and every run had plenty: from 83 to 469. They are
  answers lost on the way back, plus chargers that dropped offline in the middle of a change. Each
  one was counted as "maybe applied" until its lease was over (D-032).
- **Restarts cost usefulness, not safety.** After each restart, the controller sends nothing for
  1.8 s. Six restarts in 32 s took usefulness from about 64% to 50–54%, and the peak stayed at the
  cap.
- **Stress pace is not a usefulness benchmark.** Cars arrive and leave faster than the controller's
  50 ms tick, so it is always catching up. The calm pace is the fair number. What still holds it
  below 100% there: refused and unanswered limits, chargers that are offline and can't be raised,
  and the rule that a connector has only one change in flight.
- **A seed fixes the decisions, not the timing.** Offline spells last real milliseconds, so which
  chargers are online at each change depends on timing. The same seed can end with a slightly
  different number of arrivals, or a few more or fewer offline spells. The verdict doesn't change.

## How the work got here

- **The first cap test failed:** a peak of 120,420 W against a 60,000 W cap. The bug was in the
  simulator: a charger didn't record going back to its default when its session stopped.
- **Five earlier 1,000-change runs** (before lost answers were simulated) all ended at exactly 504
  arrivals and 496 departures. That looked like a bug. The random generator checked out over 200
  seeds, fake chargers gave different results for different seeds, and rerunning seeds 2 and 3
  gave 505/495 and 503/497. It was chance, explained by the point above.
- **Lost answers changed two things.** Ticks no longer wait for answers, and an unconfirmed
  decrease no longer holds back every other increase (D-033). The second change raised usefulness
  at a calm pace from 75–82% to 83–86% on four seeds, with the cap held every time.

## Limits

- One machine, one gateway, and an in-process controller. A "restart" is a fresh controller
  object that has lost its memory, not a killed pod. Pods come in Milestone 4.
- Time is scaled down: 50 ms ticks and 1.5 s leases instead of 1 s and 30 s.
- The chargers follow my model of the OCPP 1.6 smart-charging rules: one connector, one stack
  level, and a limit that applies at the moment the charger answers. Real firmware varies.
