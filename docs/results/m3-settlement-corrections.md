# Milestone 3: settlement and corrections while gateways crash

**Result.** The same 5,000-session crash runs as
[m3-billing-with-gateway-kills.md](m3-billing-with-gateway-kills.md), now with settlement running
all the time (D-034). With no quiet period, every session settled within milliseconds of its last
evidence, while the chargers were still running and gateways were being killed. Evidence that
arrived after that went in as corrections. In every run, every session settled, and every settled
bill plus its corrections equalled the bill its evidence proves.

## How to reproduce

```bash
pnpm db:up
pnpm db:migrate
pnpm faults --sessions 5000 --chargers 100 --gateways 3 --chaos --seed 1 --settle-quiet 0
pnpm faults --sessions 5000 --chargers 100 --gateways 3 --chaos --seed 1 --settle-quiet 1000
```

Seeds 2 and 3 use `--seed 2` and `--seed 3`. Each run saves its full report under `.runs/`.

## Setup

Everything is as in [m3-billing-with-gateway-kills.md](m3-billing-with-gateway-kills.md): the
same machine and software, three gateway processes with one killed by SIGKILL every 0.5 to 1.5 s,
100 chargers, 5,000 sessions, and the same charger faults. One thing is added:

- **A settler** in the test process runs `settleDueSessions` every 10 ms while the chargers run,
  then makes one last pass once they have finished. With `--settle-quiet 0`, a session settles as
  soon as it has no newer evidence; with `--settle-quiet 1000`, once it has had none for 1 s.

The checker then also requires, for every session: it is settled; its settled bill plus its
corrections equals its bill; and if it has corrections, at least one of its readings really came
after its stop.

## Outcome (every run)

| Run                | Settled while running / at the end | Corrections | Sessions corrected | Correction total | Discrepancies | Lost | Invented | Replay mismatches | Gateway kills | Reconnects | Time   |
| ------------------ | ---------------------------------- | ----------- | ------------------ | ---------------- | ------------- | ---- | -------- | ----------------- | ------------- | ---------- | ------ |
| seed 1, quiet 0 ms | 5,000 / 0                          | 7           | 4                  | +5,375 Wh        | 0             | 0    | 0        | 0                 | 14            | 459        | 26.9 s |
| seed 2, quiet 0 ms | 5,000 / 0                          | 10          | 6                  | +1,085 Wh        | 0             | 0    | 0        | 0                 | 15            | 475        | 27.9 s |
| seed 3, quiet 0 ms | 5,000 / 0                          | 13          | 8                  | +3,367 Wh        | 0             | 0    | 0        | 0                 | 17            | 452        | 32.0 s |
| seed 1, quiet 1 s  | 5,000 / 0                          | 0           | 0                  | 0 Wh             | 0             | 0    | 0        | 0                 | 14            | 449        | 27.6 s |

## Reading the numbers

- **Settlement changed no bill.** Seeds 1, 2 and 3 billed exactly 15,954,825 Wh, 16,499,037 Wh
  and 16,097,514 Wh, the same as the runs without settlement. Settlement only decides when a bill
  becomes final; the evidence decides the amount.
- **Corrections are rare, and each one has a reason.** Of the 5,000 sessions in seed 1, 71 had
  readings that arrived after their stop. A late reading changes a bill only if it reveals a meter
  reset (D-024), and only if the session had already settled when it arrived: 4 sessions in seed 1,
  6 in seed 2 and 8 in seed 3. Some got more than one correction, because their late readings came
  in separate messages. The checker found no correction on a session without a late reading.
- **Every correction made a bill bigger, and that is guaranteed.** A late reading can only reveal
  energy the stop alone couldn't prove. A property test checks it: adding one more reading never
  lowers a bill.
- **One second of quiet removed every correction.** Seed 1 with a 1 s quiet period had the same
  faults and the same 71 sessions with readings after their stop, and 0 corrections. In the
  simulator, a reconnecting charger flushes its queue within milliseconds. Real chargers are
  slower, and the production default of 15 minutes leaves a wide margin.

## Limits

- The quiet periods here (0 and 1 s) are tiny because the simulator compresses time. The
  production default is 15 minutes.
- Corrections are counted and checked, but nothing yet sends them anywhere: there is no invoicing
  in this project.
- A session whose StopTransaction never arrives would never settle. These runs don't produce any,
  because every simulated session ends with a stop.
