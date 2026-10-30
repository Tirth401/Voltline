# Interview preparation

Use this guide to talk about Voltline with confidence. Every number here comes from a real run,
and each one says where it comes from. If a number is not in this guide, do not quote it.

**How to practise:** read a question, cover the answer, and say your answer out loud. Then compare.
You don't need the same words. You need the same main idea and one concrete example.

---

## The 30-second pitch

> "Voltline is a backend for electric vehicle chargers. Chargers talk to it using OCPP 1.6 over
> WebSockets. The hard part is billing: chargers lose their connection, send messages twice, send
> them late or in the wrong order, and sometimes their meters reset. I built the server and a
> simulator of misbehaving chargers. With seeded fault injection, 5,000 sessions are billed
> exactly to the watt-hour, even while gateway processes are being killed. I can also replay any
> charger's recorded traffic to reproduce its bills. And it keeps every site under its power cap:
> over 1,000 load changes, with chargers refusing limits and losing answers, the limits the
> chargers really applied never went over the cap."

## The 2-minute walkthrough

1. **The problem.** A charger reports a start, meter readings and a stop. The server works out the
   bill. The network is unreliable, so every message can arrive twice, late or out of order.
2. **The core rule.** The server saves each message to the database before it answers. If it
   crashes in between, the charger sends the message again, and the server recognises the copy.
3. **Recognising copies.** A session start is identified by the charger, connector, start time and
   start meter reading. The charger chooses all four, so a resent copy always matches.
4. **Working out the bill.** The bill is always recalculated from all the stored readings, sorted
   by the charger's timestamps. It is never a running total, so duplicates and late readings
   cannot change it by mistake.
5. **Testing.** A simulator injects faults decided by a seed. Each test checks every session
   against what the simulated meter can prove, and also proves the faults really happened.
6. **Replay.** Every message is recorded. I can replay a charger into an empty database and get
   the same bills. That needed one trick: translating the server-assigned transaction IDs.
7. **Smart charging.** A controller shares each site's power cap fairly and sends limits with a
   lease, so a charger we lose contact with falls back to a safe default by itself. A command with
   no answer counts as "maybe applied" until its lease is over. The check uses what the chargers
   really applied, and two deliberately broken controllers prove that the check can fail.

---

## Numbers you can quote

| Number                   | What it means                                                                                  | Source                                          |
| ------------------------ | ---------------------------------------------------------------------------------------------- | ----------------------------------------------- |
| 500 sessions × 3 seeds   | Milestone 2 runs, each with injected faults                                                    | `docs/results/m2-billing-under-faults.md`       |
| 0 discrepancies          | In every run, every bill equalled what the readings prove                                      | same                                            |
| 0 lost, 0 invented       | Every session exists exactly once in the database                                              | same                                            |
| 41 / 47 / 52             | Late StartTransactions in seeds 1 / 2 / 3                                                      | same                                            |
| 683 / 656 / 628          | Lost answers in seeds 1 / 2 / 3, counted per message                                           | same                                            |
| 3.4–3.8 s                | Time for one 500-session run on my laptop (simulated time is compressed, not a benchmark)      | same                                            |
| 56                       | Official OCPP 1.6 schema files, byte-identical to the download                                 | `pnpm prereqs`                                  |
| 72 + 32                  | Unit tests + integration tests at the end of Milestone 2                                       | `pnpm check`, `pnpm test:integration`           |
| 5,000 sessions × 3 seeds | Milestone 3 runs: 3 gateway processes, one killed with SIGKILL every 0.5–1.5 s                 | `docs/results/m3-billing-with-gateway-kills.md` |
| 12 / 13 / 12             | Gateway kills in seeds 1 / 2 / 3                                                               | same                                            |
| 377 / 421 / 392          | Times a charger's connection broke under it and it reconnected                                 | same                                            |
| 0 / 0 / 0                | Discrepancies, lost and invented sessions, and replay mismatches, in every crash run           | same                                            |
| 377 then 402             | Reconnects in two runs of the same seed: only timing changed; faults and energy were identical | same                                            |
| 3.5 s → 4.8 s            | What the group commit cost on the 500-session run                                              | `DECISIONS.md` D-023                            |
| 80 + 45                  | Unit tests + integration tests during Milestone 3                                              | `pnpm check`, `pnpm test:integration`           |
| 90 + 54                  | Unit tests + integration tests once the smart-charging work was done                           | `pnpm check`, `pnpm test:integration`           |
| 91 + 64                  | Unit tests + integration tests at the end of Milestone 3                                       | `pnpm check`, `pnpm test:integration`           |
| 7 / 10 / 13              | Corrections in three 5,000-session crash runs that settled every bill the moment it stopped    | `docs/results/m3-settlement-corrections.md`     |
| 0                        | Corrections in the same seed-1 run with one second of quiet before settling                    | same                                            |
| 2,000                    | Idle chargers in every reconnect storm; every one came back, in every run                      | `docs/results/m3-reconnect-storm.md`            |
| 667 / 642 / 686          | Chargers on the killed gateway (one of three), exactly as the registry said                    | same                                            |
| about 2 s                | After all gateways were killed, the last charger was back about one backoff cap after them     | same                                            |
| 3.6 s vs 4.3 s           | Full outage, last charger back: without jitter vs with it. Without was faster here             | same                                            |
| 1,000 load changes × 10  | Smart-charging runs: 20 chargers, a 150 kW cap, chargers refusing limits and losing answers    | `docs/results/m3-smart-charging-cap.md`         |
| 150,000 W                | The peak in every run: exactly the cap, never a watt more                                      | same                                            |
| 83 to 469                | Unanswered limit changes per run, each counted as "maybe applied" until its lease ended        | same                                            |
| 88–89%                   | Usefulness at a calm pace: the share of the spare power the chargers were allowed to use       | same                                            |
| 120,420 W vs 60,000 W    | The first cap test's peak; the bug was in the simulator, not the controller                    | `DECISIONS.md` D-032                            |
| 38,790 W vs 30,000 W     | What a restarted controller with no waiting period does, in a scripted test                    | `docs/results/m3-smart-charging-cap.md`         |
| 75–82% → 83–86%          | Usefulness before and after relaxing the "no increase while a decrease is unconfirmed" rule    | `DECISIONS.md` D-033                            |
| 504 / 496                | Five runs that ended the same way by chance; reruns gave 505/495 and 503/497                   | `docs/BUILD_JOURNAL.md`, Milestone 3 Part 4     |

---

## Questions and answers

### The protocol

**Q: What is OCPP, and why version 1.6?**
OCPP is the open standard that chargers and backends use to talk. Version 1.6 is still the most
widely deployed. Version 2.0.1 is not just an upgrade: it changes how transactions work and adds
a large device model. Doing both in one semester would make everything shallow, so 2.0.1 is a
stretch goal.

**Q: How does a charger connect?**
It opens a WebSocket to `/ocpp/{its-id}` and asks for the `ocpp1.6` subprotocol. If the ID is not
registered, the gateway refuses before the WebSocket even opens (HTTP 404). If the charger does
not speak `ocpp1.6`, it is refused with HTTP 400.

**Q: What does a message look like?**
A JSON array. A request is `[2, messageId, action, payload]`. A success answer is
`[3, messageId, payload]`. An error is `[4, messageId, errorCode, description, details]`. The
message ID links an answer to its request.

**Q: Why handle one message at a time per charger?**
Order matters. The StartTransaction must be saved before the first meter reading of that session
is handled. But answers to our own requests skip that queue. Otherwise, a handler that waits for
the charger's answer would wait behind itself forever.

**Q: How do you validate messages?**
Against the official JSON schemas from the Open Charge Alliance. Failures map to OCPP error
codes: a missing field is `OccurenceConstraintViolation`, which is the spec's own misspelling.
TypeScript types are generated from the same schemas, so code and validation cannot disagree.

### Billing correctness

**Q: The charger sends StartTransaction twice. How do you avoid two sessions?**
The session has a unique key: charger, connector, start time and start meter reading. The second
insert hits that key, so the server finds the existing session and returns the same
transactionId. Two different real sessions cannot share all four values.

**Q: Why not use the OCPP message ID as the duplicate key?**
OCPP only requires message IDs to be unique within one connection. The retries that matter happen
after a reconnect, and the charger may give the resent message a new ID.

**Q: Why not use the time the server received the message?**
Because a charger that was offline sends its messages late. The session started when the charger
says it did, not when we heard about it.

**Q: Why store energy as integers?**
Decimal numbers are inexact in binary. In JavaScript, `0.1 + 0.2` is `0.30000000000000004`.
Energy is money, so we store whole watt-hours and parse meter strings exactly, without floats.

**Q: A meter reading arrives after the session has stopped. What happens?**
We save it, and if the session is already stopped, we work out its bill again from all the
evidence. To make that safe when the stop and the reading arrive at the same moment, the reading
is committed first, and then we lock the session's row. Whatever the timing, one of them sees the
other. A test runs that race 20 times.

**Q: How do you handle meter resets? Can you always detect them?**
No, not always, and that is an important point. A reset is visible only if the next reading is
lower than the last one. If the meter resets and then climbs past the old value before the next
reading, the readings look like normal growth. So we bill what the readings can prove: we may
undercharge in that case, but we never overcharge. Chargers that report a reading just before
and just after a reboot make every reset visible.

**Q: What does "zero discrepancies" mean exactly?**
The bill equals the energy that the charger's readings can prove. It is not "the bill equals the
energy that physically flowed", because energy hidden by an unreported reset cannot be proved by
anyone. We report that gap separately: between 3,514 Wh and 5,186 Wh per 500-session run.

**Q: When is a bill final? Why not just keep re-billing forever?**
A bill settles once no new evidence for its session has arrived for a quiet period, 15 minutes by
default. From then on, the settled amount never changes. A real business sends that amount on, as
an invoice or to the driver's provider, so changing it quietly would make the books disagree. If
evidence still arrives and changes the amount, I add a correction instead: old amount, new amount,
difference. The settled bill plus its corrections always equals the bill the evidence proves.

**Q: Why a quiet period, and not a fixed time after the stop?**
Because a charger that reconnects flushes its queue, and some readings can arrive after the stop.
Each new piece of evidence restarts the clock, so a charger that is still catching up holds its
sessions back.

**Q: A late reading and the settlement job hit the same session at the same moment. What happens?**
The reading locks the session's row while it re-bills. The settlement update waits for the lock,
and then Postgres checks its `WHERE` again against the new row. So the reading is either inside
the settled bill or becomes a correction, never lost and never counted twice. A test races two
settlers and a late reading 20 times.

**Q: How do you test corrections, if they almost never happen?**
I make them happen on purpose. In the fault runs, a settler with no quiet period settles each
session the moment it stops, while chargers misbehave and gateways crash. Late evidence must then
become a correction, and the checker verifies the sum for every session.

### Reliability

**Q: What if the gateway crashes after saving a message but before answering?**
The charger never gets the answer, so it sends the message again. The duplicate key and the
"insert or do nothing" writes absorb the copy. Nothing is lost and nothing is counted twice.

**Q: Why not answer with an error when you don't know a transaction?**
In OCPP 1.6, a charger may delete a transaction message after several error answers. An error
for "unknown transaction" could quietly delete billing data. So we save it, flag it and answer OK.

**Q: How do you find connections that died silently?**
The gateway pings each WebSocket every 30 seconds. If the last ping got no pong, it closes the
socket. Without this, a charger that lost power could look connected forever.

### Testing

**Q: Your tests are random. How do you reproduce a failure?**
Every random choice comes from a seeded generator, so the same seed gives the same scenario. But
a seed cannot control network timing. So the gateway also records every message, and I can
replay a charger's real traffic into an empty database. Seeds reproduce the scenario; recordings
reproduce the run.

**Q: How do you know a fault test is not passing by accident?**
Each test run counts the faults that actually happened and fails if any kind is zero. A chaos
test that injects nothing proves nothing.

**Q: What is property-based testing, and where did you use it?**
Instead of one example, you state a rule and the library tries hundreds of random inputs. For
example: "dropping, duplicating or shuffling the readings never changes the bill". When a case
fails, the library shrinks it to the smallest failing example and prints its seed.

**Q: Why did your replay need transaction-ID translation?**
In OCPP 1.6 the server assigns transaction IDs. A replay into a new database gives out new IDs in
a different order, so the recorded stops pointed at the wrong sessions. My first replay got
almost every bill wrong. The fix reads the server's recorded answer to each StartTransaction and
translates old IDs to new ones. The lesson works for any system: if the server assigns IDs,
replay must translate them.

**Q: Why did you write your own simulator instead of using an existing one?**
Because I need ground truth. My simulator knows exactly how much energy flowed and which readings
it sent, so every bill can be checked to the watt-hour. Later, I will also test against SAP's
open-source charger simulator, to check that we work with code I did not write.

### Crashes and several gateways

**Q: How did you test that billing survives server crashes?**
I run three gateway processes. A seeded chaos loop kills one with SIGKILL every 0.5 to 1.5 seconds
and restarts it shortly after. 100 simulated chargers run 5,000 sessions through them. Across
three seeds there were 12 or 13 kills per run and about 400 broken connections, and every run had
zero discrepancies, with no session lost or invented.

**Q: Why SIGKILL and not a normal shutdown?**
SIGKILL is a real crash: the process gets no chance to close sockets, finish database
transactions or flush buffers. It is like a power cut. A polite SIGTERM lets the program tidy up,
which hides exactly the bugs I want to find.

**Q: What happens to a message the gateway was handling when it died?**
There are two cases, and both are safe. If the gateway saved the message but died before
answering, the charger never got an answer, so it sends the message again. The duplicate key
recognises the copy. If the gateway died before saving, nothing was saved, and the resent copy is
saved normally. Either way the result is exactly one record.

**Q: How do chargers reconnect without overloading the server?**
With exponential backoff and jitter. After each failed try, the longest wait doubles, from 50 ms
up to 2 s, and the real wait is a random time below it. The randomness spreads the chargers out,
so they don't all hit the next gateway at the same instant.

**Q: Your tests are seeded. Do they stay reproducible when there are crashes?**
The charger's behaviour does, yes. Crash timing cannot be seeded, so the network choices
(reconnects and backoff waits) use a separate random stream. I reran the same seed with crashes:
the faults and the energy were identical, and only the reconnect count changed, from 377 to 402.

**Q: How do you keep your recording complete if a process can die at any moment?**
Group commit. The gateway sends an answer only after the frame log has stored the message and
the answer. All connections share each write, so it costs a few milliseconds, not throughput. So
if a charger got an answer, the message is in the log. If it didn't, the charger resends it and the
copy is logged. In my 500-session run this took the time from 3.5 s to 4.8 s.

**Q: With several gateways, how does a command find the right charger?**
A Redis registry records which gateway holds each charger's connection. The API looks it up and
publishes the command on that gateway's Redis channel. The gateway sends it over the WebSocket,
checks the charger's answer against the official schema, and publishes the reply back. If nobody
receives the published message, that gateway has died, and the API answers "not connected" at once.

**Q: Why not use a message queue such as Kafka for commands?**
Because a command delivered late is worse than one that fails. If "start charging" arrives a
minute later, the driver may have left. With a timeout, the caller always knows within seconds
whether it worked, and can retry with fresh information.

**Q: What if a charger reconnects to a new gateway while its old socket still looks open?**
When the new gateway registers the charger, the registry returns the previous owner, and that
gateway is told to close the old socket. A connection only removes itself from the registry if it
is still the owner, so an old socket closing late cannot erase the new one.

**Q: How did you measure how fast chargers reconnect after a gateway dies?**
From the chargers' side. Each simulated charger writes down when it noticed the lost connection
and when a gateway accepted its BootNotification again. I report p50, p95, p99 and the maximum,
never only an average, because the slowest chargers are the ones people complain about. With
2,000 chargers and one of three gateways killed, every charger came back; the slowest took about
2 seconds.

**Q: How do you know no charger is missing from those numbers?**
Before the kill, the Redis registry tells me which chargers are on the gateway I'm about to kill.
The chargers that report a lost connection must be exactly those: 667, 642 and 686 in my three
runs, and they were. Afterwards, every one of the 2,000 must be registered again.

**Q: Does jitter help?**
Less than I expected, and I measured it. Without jitter, all 2,000 chargers retried in the same
instant after a full outage, and the gateways took them all within half a second, so recovery was
0.6 seconds faster. Jitter is insurance for a wave the gateways can't absorb: chargers in step
then fail together and retry together, forever. My gateways had spare capacity, so jitter only
cost time. I'll test it properly once BootNotification rate limiting makes the capacity limit
real.

**Q: Would the numbers be the same in production?**
No, they are a lower bound. On one machine, SIGKILL makes the kernel reset the sockets at once, so
chargers notice immediately. Across a real network a dead server may send nothing, and noticing
takes until a ping times out. Real chargers also back off for longer than my 2 seconds.

### Smart charging

**Q: How do you keep a site under its power cap?**
Every connector keeps a small default limit, and the rest of the cap is shared fairly between
the cars that want more ("water filling"). Limits change in a safe order: decreases first, and
increases only after the decreases are confirmed, and only into power that is free even in the
worst case.

**Q: Why reserve power for an empty connector?**
Because a car can plug in and start drawing the connector's default limit before the backend
reacts. If we gave that power away, a new car arriving could push the site over its cap.

**Q: Why decreases before increases? Can you give an example?**
Cap 18,280 W, two connectors with a 4,140 W default. Car A alone has 14,140 W. Car B arrives,
and the fair split is 9,140 W each. If I raised B first, for a moment the site could draw
14,140 + 9,140 = 23,280 W. So A goes down first, and B goes up only after A's charger confirms.

**Q: What if a charger never answers a decrease?**
Then I don't know which limit it is using, so I count the higher one. That is the worst case.
Increases only use power that is still free in the worst case, so nothing that depends on the
missing answer is sent. A lease (`validTo`) on each limit means a charger that went silent falls
back to its default on its own.

**Q: How do you know the safety test isn't trivially true?**
A controller that gives everyone zero would never break the cap. So a second property test
checks that once chargers answer again, every connector reaches its fair target. Safety and
usefulness are tested together.

**Q: What does "level-triggered" mean, and why use it?**
The controller works out the next changes from the current state alone, not from the list of
events that led there. If an event is lost or repeated, the next run still computes the right
thing. Kubernetes controllers work the same way.

**Q: What is a lease, and why does every limit have one?**
Each limit I send carries a `validTo` time, 30 seconds ahead, and I renew it when half of it is
used. If the charger loses contact with us, the lease runs out and the charger goes back to its
safe default by itself. So safety doesn't depend on the network. Without a lease, a charger I
can't reach would keep a high limit forever, and I could never give that power to another car.

**Q: A SetChargingProfile times out. What does the controller do?**
It treats the outcome as unknown. Maybe the charger never got it; maybe it applied it and only
the answer was lost. So the change counts as "maybe applied" until its lease would be over, plus
2 seconds for clock differences. After that, the charger is on its default whatever happened. The
classic bug is to treat a timeout as "not applied" and give the same power to another car.

**Q: How do you check the cap from outside the controller?**
Each simulated charger records every limit it actually applies, with a timestamp. The test adds
these up moment by moment, with idle connectors at their default, and takes the highest total.
The controller's beliefs are not used, so a bug in those beliefs can't hide itself.

**Q: How do you know the cap test can fail?**
Two broken controllers must fail it, and the tests check that they do. One sends every target at
once, with no ordering and no worst-case budget. The other is a restart with no waiting period,
in a scripted test: car A holds all the spare power, its charger goes offline keeping that limit,
the controller restarts, and car B arrives. The new controller gives B a share while A still holds
its old limit: 38,790 W against a 30,000 W cap.

**Q: What happens if the controller crashes and restarts?**
The new one remembers nothing, so it thinks every charger is on its default. But a charger may
still hold a high limit from before the crash. If the new controller gave that power to another
car, the site would go over the cap. So a fresh controller sends nothing for one lease plus the
clock allowance. After that, every old lease has run out and its belief is true again.

**Q: Why doesn't each tick wait for the chargers' answers?**
Because one silent charger would hold up the whole site until the timeout, and in the meantime
other leases could run out. Now answers update the controller's beliefs when they arrive. If an
answer comes after the controller already gave up on that change, it is ignored.

**Q: You changed one of your own rules (D-033). Why?**
D-031 said no increase while any decrease is unconfirmed. Once my simulated chargers could lose
answers, the usefulness number showed the cost: a decrease with a lost answer stays unconfirmed
for a whole lease, so the whole site froze, 32 seconds in production. The worst-case budget
already makes sure no increase uses power that isn't free yet, so the strict rule added no safety.
After relaxing it, usefulness went from 75–82% to 83–86% on four seeds, and the cap still held.

**Q: Tell me about a result that looked wrong.**
Five 1,000-change runs with five different seeds all ended at exactly 504 arrivals and 496
departures. I didn't report it until I understood it. The random generator passed a check over
200 seeds, and fake chargers gave different results for different seeds. Rerunning seeds 2 and 3
gave 505/495 and 503/497. Offline spells last real milliseconds, so the exact split depends on
timing: a seed fixes the decisions, not the timing. Five matching results were chance.

### Design choices

**Q: Why is billing inside the gateway and not a separate service?**
The key rule is "save, then answer". A network call to a billing service between those two steps
adds a new way to fail, and it does not help any of our goals. I split out services only for a
real operational reason.

**Q: Why no ORM?**
Correct billing depends on exact SQL: `INSERT … ON CONFLICT`, row locks and transaction
boundaries. An ORM hides exactly those details. TimescaleDB tables also need raw SQL.

**Q: Why TimescaleDB?**
Meter readings are time series. TimescaleDB stores them in time-based chunks and keeps normal
Postgres SQL. We only needed one rule from it: every unique index must include the time column,
and our duplicate key already does.

---

## Be honest about limitations

Saying these yourself makes you more convincing, not less.

- The crashes so far are of processes on one machine, not pods in Kubernetes. That comes in
  Milestone 4. Only gateways crash; Postgres and Redis stay up. There are no network partitions
  yet: a gateway is either fully up or dead.
- The faults come from my own model of an OCPP 1.6 charger. Real firmware varies. Testing with
  SAP's simulator comes later.
- Simulated time is compressed. The run times show how long a test takes on my laptop. They are
  not performance results.
- Energy hidden by an unreported meter reset is not billed. That is a choice, and we report it.
- Smart charging is simulated with one connector per charger and one stack level. Leases assume
  the charger's clock roughly agrees with ours. There is exactly one controller per site, with no
  leader election, and a fresh one sends no new limits for its first 32 seconds.
- In the cap stress test, cars arrive and leave faster than the controller's tick, so usefulness
  there is low by design. The calmer runs are the fair usefulness number.
- Corrections are recorded and checked, but nothing sends them anywhere: there is no invoicing. A
  session whose StopTransaction never arrives never settles.
- The reconnect numbers are a lower bound: on one machine a killed process's sockets are reset at
  once, and my backoff cap is 2 s. After a gateway restarts, connections don't rebalance.

---

## Glossary

| Term                   | Meaning                                                                                               |
| ---------------------- | ----------------------------------------------------------------------------------------------------- |
| CSMS                   | Charge Station Management System: the server that chargers talk to.                                   |
| OCPP                   | Open Charge Point Protocol: the standard language between chargers and the CSMS.                      |
| WebSocket              | A network connection that stays open, so both sides can send messages at any time.                    |
| Session / transaction  | One charging session, from StartTransaction to StopTransaction.                                       |
| idTag                  | The ID of the card or app that started the session.                                                   |
| Wh, kWh                | Watt-hour and kilowatt-hour: units of energy. 1 kWh = 1,000 Wh.                                       |
| Meter register         | The meter's running total of energy, like the odometer in a car.                                      |
| Idempotent             | Safe to do twice: the second time changes nothing.                                                    |
| At-least-once delivery | A message may arrive more than once, but it is never lost.                                            |
| Duplicate key          | The values that identify "the same thing", so a copy can be recognised.                               |
| Seed                   | The starting number for a random generator. The same seed gives the same choices.                     |
| Property-based test    | A test that checks a rule against many generated inputs.                                              |
| Replay                 | Feeding recorded messages into a fresh system to reproduce a past run.                                |
| Row lock               | A database lock on one row, so two operations on it take turns.                                       |
| Gateway                | The server process that holds the chargers' WebSocket connections.                                    |
| SIGKILL                | A signal that stops a process immediately, with no chance to clean up: a realistic crash.             |
| Backoff and jitter     | Waiting longer after each failed retry (backoff), by a random amount (jitter), so retries spread out. |
| Group commit           | Many writers waiting for one shared database write, which makes the guarantee cheap.                  |
| Pub/sub                | Publish/subscribe: a message sent on a named channel reaches whoever is listening on it right now.    |
| Registry               | Here, the Redis record of which gateway holds each charger's connection.                              |
| Epoch                  | A counter that grows with each new connection of a charger, so newer can be told from older.          |
| Cap                    | The most power a site may draw at once.                                                               |
| Settled bill           | A session's bill once its evidence has gone quiet: it is never changed after that.                    |
| Jitter                 | Waiting a random part of a backoff, so clients that failed together don't all retry together.         |
| p50 / p95 / p99        | The value that 50% / 95% / 99% of the measurements are at or below.                                   |
| Correction             | A dated record of a change to a settled bill: old amount, new amount, difference.                     |
| Default limit          | What a charger may draw with no instructions from us (its TxDefaultProfile).                          |
| Lease (`validTo`)      | The time a limit stops applying unless it is renewed; then the charger falls back to its default.     |
| Worst case             | The most a connector might be drawing, given changes we sent but haven't heard back about.            |
| Usefulness             | The share of the spare power the chargers were really allowed to use, over time.                      |
| Negative control       | A deliberately broken version that the test must catch, to prove the test can fail.                   |
