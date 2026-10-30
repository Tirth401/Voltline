# Milestone 4: the kind trial, and gateways that rebalance after a restart

**Result.** Two things, both measured from a Job inside the kind cluster, from the chargers' side.

1. **The kind trial**, planned for Milestone 1: 2,000 idle chargers connecting at once to a single
   gateway pod. In three runs, all 2,000 were accepted, the pod held them with 116 to 124 MiB of
   memory, and not one connection dropped in 30 seconds of watching.
2. **Recovery and rebalancing** after one of three gateway pods is killed, in each of the three
   ways the chaos driver kills (D-040). In every final run, every charger the killed pod held came
   back, none gave up, and afterwards the gateways rebalanced to within 10% of an even spread
   (D-039). The registry agreed with the gateways' own lists every time.

These are not result 3: that needs several runs of each scenario, with and without jitter and rate
limiting, and comes in Milestone 5. They check that the machinery works.

## How to reproduce

```bash
pnpm kind:up
pnpm kind:storm --chargers 2000 --gateways 1 --kill none --hold 30000 --seed 2
pnpm kind:storm --chargers 2000 --kill one --kill-mode crash --hold 15000 --seed 1
pnpm kind:storm --chargers 2000 --kill one --kill-mode delete --hold 15000 --seed 1
pnpm kind:storm --chargers 2000 --kill one --kill-mode drain --hold 20000 --seed 1
```

`--gateways 1` scales the gateways to one pod for the run, and back to three afterwards. Each run
saves its full report, with the per-second spread, under `.runs/`.

## Setup

- **Date:** 2026-10-30 (UTC). **Machine and software:** as in
  [m4-billing-with-pod-kills.md](m4-billing-with-pod-kills.md).
- **Chargers:** 2,000 `IdleCharger`s in one Job inside the cluster (D-035). Each connects to the
  gateway Service, boots, reports Available, and stays connected. Lost connections are retried
  with exponential backoff and full jitter, capped at 2 s (D-028).
- **Gateways:** as deployed by `pnpm kind:up`: a boot budget of 500 a second shared by all of them
  (D-038), rebalancing every second (D-039), and a 10 s drain when stopped (D-037).
- **Measured per charger:** from noticing a lost connection to a gateway accepting its
  BootNotification again. Each gateway also reports how many chargers it holds, read once a second
  from its pod address.
- **The check** (D-040): the chargers expected to notice the kill are the ones in the killed pod's
  own list of its sockets, read just before. Every one of them must come back, none may give up,
  the registry must agree with the gateways' lists, and nobody may lose a connection while we
  watch afterwards (moves made by rebalancing are counted apart).

## The kind trial: 2,000 chargers into one pod

| Run    | Boot budget | All accepted after | Per charger p50 / p95 / p99 / max | Boots answered Pending | Pod memory | Lost in 30 s |
| ------ | ----------- | ------------------ | --------------------------------- | ---------------------- | ---------- | ------------ |
| seed 1 | none yet    | 1,389 ms           | 589 / 1,286 / 1,307 / 1,331 ms    | 0                      | 122 MiB    | 0            |
| seed 2 | 500 a sec   | 3,632 ms           | 1,556 / 3,560 / 3,570 / 3,570 ms  | 1,447                  | 116 MiB    | 0            |
| seed 3 | 500 a sec   | 3,725 ms           | 1,632 / 3,633 / 3,633 / 3,633 ms  | 1,470                  | 124 MiB    | 0            |

The first run was before the boot budget existed. With the budget, a cold start takes longer on
purpose: 500 boots go through at once, and the rest are given appointments spread over the next
three seconds. In every run the registry held all 2,000 chargers afterwards.

## One of three gateway pods killed

| Kill mode | Seed | The pod held | Noticed | Back | Gave up | All back after the kill | Reconnect p50 / p95 / p99 / max | Most attempts | Pending boots | How the connections ended  | Moved by rebalancing | Spread at the end |
| --------- | ---- | ------------ | ------- | ---- | ------- | ----------------------- | ------------------------------- | ------------- | ------------- | -------------------------- | -------------------- | ----------------- |
| crash     | 1    | 673          | 673     | 673  | 0       | 1,725 ms                | 1,125 / 1,224 / 1,487 / 1,659   | 4             | 415           | 673 broke (1006)           | 678                  | 616 / 683 / 701   |
| crash     | 2    | 639          | 639     | 639  | 0       | 1,463 ms                | 195 / 1,229 / 1,273 / 1,371     | 5             | 87            | 639 broke (1006)           | 669                  | 637 / 680 / 683   |
| delete    | 1    | 691          | 691     | 691  | 0       | 3,343 ms                | 156 / 219 / 252 / 254           | 1             | 0             | 560 broke, 131 drained     | 473                  | 627 / 670 / 703   |
| drain     | 1    | 647          | 647     | 647  | 0       | 15,470 ms               | 15 / 456 / 1,873 / 4,933        | 8             | 0             | 595 drained, 52 rebalanced | 558                  | 656 / 666 / 678   |

Close codes, as the chargers saw them: 1006 means the connection simply broke, 1001 that the gateway
closed it while shutting down, and 1013 that it moved the charger to rebalance. In every run the
registry agreed with the gateways' own lists for all 2,000 chargers, all 2,000 were registered at
the end, and no connection was lost while we watched.

How the crashed pod (seed 2, crash) filled up again, counted by the gateways themselves, once a
second from the moment every charger was back:

| Seconds          | 0     | 1   | 2   | 3   | 4   | 5   | 6   | 7   | 8   | 9 onwards |
| ---------------- | ----- | --- | --- | --- | --- | --- | --- | --- | --- | --------- |
| Restarted pod    | 0     | 36  | 123 | 213 | 317 | 413 | 511 | 603 | 631 | 637       |
| The other two    | 1,004 | 983 | 932 | 882 | 831 | 781 | 730 | 685 | 676 | 680       |
| (second of them) | 996   | 962 | 911 | 861 | 810 | 760 | 709 | 673 | 675 | 683       |

## Reading the numbers

- **One pod can hold 2,000 chargers** with memory to spare (its limit is 512 MiB), and the in-cluster
  setup measures from where a real client would be.
- **How a pod dies changes what the chargers see.**
  - After a **crash**, every connection breaks at once. The chargers come back within about 1.7 s.
    In seed 1, many had to wait for a boot appointment (415 Pending), because the budget was still
    busy with the cold start that had just finished.
  - After a **forced delete**, the pod lives on for about 2 seconds of grace. It drains some
    connections (131) before it is killed. The chargers come back fast (p99 252 ms), and the last
    one about 3.3 s after the delete.
  - After a **drain**, the connections close one by one over 10 s, after a 5 s pause. So the last
    charger is back about 15 s after the delete, but each one waits only a moment (p50 15 ms). No
    charger loses its connection all at once. 52 of them were moved by rebalancing during the
    pause: the dying pod was still on the load board while its replacement arrived empty.
- **Rebalancing refills a restarted pod in about 8 seconds,** at up to 50 chargers per gateway per
  second, and then stops within the slack: no gateway is more than 10% (67 chargers) from the fair
  share of 667. It moved 473 to 678 chargers, about one move per charger the pod needed.
- **Without rebalancing**, as in Milestone 3, the restarted pod would have stayed almost empty.

## Every run, including the development runs

The checks above changed during the milestone, and each change came from a run. All of them:

| When (UTC)  | Command (kind:storm, 2,000 chargers)      | Outcome                                                                                                                                                                                                                                                                            |
| ----------- | ----------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 19:30       | `--gateways 1 --kill none --seed 1`       | passed: the first trial row above                                                                                                                                                                                                                                                  |
| 19:47       | `--kill one --kill-mode delete --seed 1`  | marked failed: 951 chargers lost their connection where the registry had 679 on the pod. The extra 272 were rebalancing moves, which the check didn't count apart yet. Fixed the check (close codes)                                                                               |
| 19:50       | the same                                  | passed: 702 held, 702 back, all back after 7.5 s; rebalancing had no patience yet                                                                                                                                                                                                  |
| 19:51       | `--kill one --kill-mode crash --seed 2`   | failed: only 601 of 644 noticed (the registry's count). The run waited three minutes for the rest                                                                                                                                                                                  |
| 19:56       | the same                                  | failed: 626 of 670 noticed. The registry now checked against the pods' own lists: 0 wrong                                                                                                                                                                                          |
| 20:01       | `--kill none --hold 60000 --seed 3`       | invalid: by mistake I started a second run (20:02) while it was running. Both used the same charger names and wiped each other's data. The script now refuses to start while another run is going                                                                                  |
| 20:04       | `--kill none --hold 90000 --seed 3`       | passed                                                                                                                                                                                                                                                                             |
| 20:06–20:09 | three `--kill none` runs                  | no report: while probing the network, I crashed a gateway by hand during each, and the runner itself crashed when a pod vanished between listing it and asking for its count. Fixed: a pod that can't be reached is left out of that sample                                        |
| 20:11       | `--kill none --hold 240000 --seed 4`      | marked failed by design: I crashed a gateway by hand during the watch. All 659 of its chargers came back, and both sides' socket counts agreed (2,003 on the chargers' side, counting 3 of the probe's own; 2,000 on the gateways'): no half-open connections                      |
| 20:15       | `--kill one --kill-mode crash --seed 2`   | failed: 594 of 634 noticed, although both sides' socket counts agreed during the run                                                                                                                                                                                               |
| 20:19       | the same                                  | failed: 699 of 701 noticed. The two silent chargers had been moved by rebalancing 0.9 and 2.1 s before the kill and were still reconnecting; one had opened 10 sockets. Fixed: rebalancing waits three rounds (D-039), and the check counts a charger caught mid-reconnect (D-040) |
| 20:24       | the same                                  | passed: the second crash row above                                                                                                                                                                                                                                                 |
| 20:38–20:40 | the two trials and three kill modes above | passed                                                                                                                                                                                                                                                                             |

## Limits

- One node: the chargers, the gateways and the database share one laptop's CPU.
- One run per scenario. Percentiles from one run show what happened, not how much it varies;
  result 3 in Milestone 5 runs each scenario several times.
- The idle chargers send nothing while idle. A connection that died without a word would go
  unnoticed until the charger next sent something. No run here had one (both sides' counts
  agreed), but Milestone 5's chargers should ping, as real ones do.
- The backoff cap is 2 s, shorter than many real chargers use.
