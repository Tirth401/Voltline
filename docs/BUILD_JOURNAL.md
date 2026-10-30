# How Voltline was built

This is the story of the project, milestone by milestone, in plain English. It explains what we
built, why we built it that way, what went wrong, and what we learned. For the short, formal
version of each decision, see [DECISIONS.md](../DECISIONS.md). For interview practice, see
[INTERVIEW_PREP.md](INTERVIEW_PREP.md).

---

## The project in one page

**What is a charging backend?** When you charge an electric car at a public charger, the charger
is not working alone. It talks all the time to a server run by the charging company. That server
is called a **CSMS** (Charge Station Management System). For example:

1. You plug in and tap your card. The charger asks the server: "Is this card allowed to charge?"
2. The server says yes. The charger tells the server: "A session started. My meter reads 10,000 Wh."
3. Every minute, the charger sends a new meter reading.
4. You unplug. The charger says: "The session stopped. My meter reads 17,800 Wh."
5. The server works out the bill: 7,800 Wh, which is 7.8 kWh.

**What is OCPP?** It is the language that chargers and servers use to talk. We use version 1.6
in its JSON form. Each message is a small piece of JSON sent over a **WebSocket**, a network
connection that stays open, so both sides can send messages at any time.

**What makes it hard?** Chargers live in car parks with bad mobile signal. They lose their
connection, send the same message twice, send old messages late, and sometimes their meters
reset. The server must still bill every session correctly, to the watt-hour.

**Our three goals:**

1. **Billing:** zero billing mistakes across 5,000 simulated sessions, even when we inject faults
   on purpose.
2. **Smart charging:** a site (a car park with a power limit) never uses more power than its limit,
   across 1,000 changes in demand.
3. **Recovery:** 2,000 simulated chargers reconnect after a gateway server restarts in Kubernetes.

**Tools:** TypeScript on Node.js, PostgreSQL with TimescaleDB for the data, Redis for fast live
state, Docker, and later Kubernetes (with kind, which runs Kubernetes on a laptop).

---

## Milestone 0: setting up the project

**Goal:** a clean project where the tools work, so later work is fast and safe.

**What we built:**

- **One repository with several packages** (a "monorepo"), managed by pnpm. Each part has its
  own folder: `ocpp` for the protocol, `billing` for sessions and money, `db` for the database,
  and so on.
- **TypeScript that runs directly on Node 24.** Node 24 can run `.ts` files without a build step.
  This means fewer tools and less to go wrong (D-003).
- **Postgres and Redis in Docker**, with exact version numbers, so every laptop runs the same
  database (D-015).
- **A random number generator that takes a seed.** Every random choice in our tests comes from
  it. If a test fails, we can run it again with the same seed and get the same scenario (D-011).
- **A checker script** (`pnpm prereqs`) that tells a new developer what is missing on their machine.

**Problems we hit:**

- **The newest TypeScript (version 7) did not work with our linter.** The linter is the tool that
  catches mistakes such as a missing `await`. We kept TypeScript 6, because that check protects
  our most important rule (D-004).
- **Our script was called `doctor`, but pnpm already has a built-in `pnpm doctor` command.** When
  you ran `pnpm doctor`, you got pnpm's report, not ours. We renamed ours to `pnpm prereqs`.
  Lesson: test the exact command a user will type, not a shortcut.
- **We checked the downloaded OCPP schemas.** All 56 files were byte-for-byte the same as the
  official download, so we know nobody changed them.

**What I learned:** a good setup is boring on purpose. Pinned versions, one command to check
everything, and a seed for every random choice save hours later.

---

## Milestone 1: one charger, one complete session

**Goal:** a simulated charger connects, charges a car, stops, and the bill in the database matches
exactly what the charger delivered.

**How a session flows through the system:**

```
Charger                          Gateway                       Database / Redis
  | --- BootNotification -------> | save charger details -------> Postgres
  | --- StatusNotification -----> | save "Available" -----------> Redis
  | --- Authorize (card) -------> | is the card allowed? <------- Postgres
  | --- StartTransaction -------> | create the session ---------> Postgres
  | <-- transactionId = 42 ------ |
  | --- MeterValues (x N) ------> | save each reading ----------> Postgres
  | --- StopTransaction --------> | save the stop, work out the bill
```

**The four most important ideas:**

1. **Save first, then answer.** The gateway saves a message to the database before it replies to
   the charger. If the gateway crashes after saving but before replying, the charger sends the
   message again, and we handle the copy safely. If it crashes before saving, the charger still
   has the message. Either way, nothing is lost (D-005).

2. **A "duplicate key" for StartTransaction.** In OCPP 1.6 the server gives each session its
   number (the transactionId). If a charger sends StartTransaction twice, we must not create two
   sessions. So we recognise a start by four things the charger chose: charger, connector, start
   time and start meter reading. A copy matches all four, so it gets the same session back (D-006).

   We did not use the message ID, because a charger may give a resent message a new ID after it
   reconnects. We did not use the time the server received the message either, because a charger
   that was offline sends its messages hours late.

3. **Whole watt-hours, never decimals.** Computers store decimals like 0.1 inexactly. In
   JavaScript, `0.1 + 0.2` gives `0.30000000000000004`. For money, that is not acceptable, so all
   energy is stored as whole watt-hours (D-007).

4. **Never reject a transaction message for a business reason.** If the charger sends a stop for a
   session we do not know, we still save it and say "OK". The reason: in OCPP 1.6, a charger may
   delete a message after it gets errors several times. An error reply could quietly delete
   billing data (D-008).

**How we tested it:**

- **Unit tests** for small pieces, such as reading OCPP messages and working out energy.
- **Property-based tests.** Instead of writing one example, we describe a rule, and the test
  library tries hundreds of random cases. For example: "however you shuffle the readings, the
  bill is the same".
- **Integration tests** against the real Postgres and Redis.
- **An end-to-end test**, where a simulated charger runs a full session through a real gateway.
- **A smoke test** (`pnpm smoke`) that starts the real gateway program and checks the bill.

**A mistake I caught in my own design:** I first planned to check billing against the simulator's
private knowledge of meter resets. Then I found a case that no server can ever see. A meter reads
1,100 Wh, resets to zero, and climbs to 1,500 Wh before the next reading. The readings look like
normal growth from 1,100 to 1,500. So the test now compares billing only with what the readings
can prove. We wrote this down honestly in DECISIONS.md as a correction (D-010).

**What I learned:** most of the hard work in billing is not maths. It is deciding what counts as
the same message, and what to do when a message arrives late or twice.

---

## Milestone 2: billing when chargers misbehave

**Goal:** 500 sessions with faults, every bill exactly right, no session lost and no session
invented.

**The faults we inject, with real-life examples:**

| Fault                 | What happens in real life                                                                         |
| --------------------- | ------------------------------------------------------------------------------------------------- |
| Offline spell         | The charger loses signal but keeps charging. It stores its messages and sends them later.         |
| Late StartTransaction | The car started charging while the charger was offline, so the server hears about the start late. |
| Lost answer           | The server replied, but the reply never arrived. The charger sends the same message again.        |
| Dropped connection    | The connection breaks right after the charger sends a message. It reconnects and sends it again.  |
| Shuffled queue        | Careless firmware sends its stored messages in the wrong order.                                   |
| Meter reset           | The meter goes back to zero. Sometimes the charger reports it, sometimes not.                     |

**How the simulator works:** each simulated charger has an **outbox**, a queue of messages it must
deliver. A message leaves the outbox only when the server has answered it. This is called
**at-least-once delivery**: a message can arrive twice, but it is never lost. All fault decisions
come from the seed, so the same seed always produces the same faults (D-025).

**A new problem: readings that arrive after the stop.** With a shuffled queue, a meter reading can
arrive after the session has already stopped and been billed. Around a meter reset, that late
reading changes the bill. So now, when a reading arrives for a stopped session, we work out the
bill again from all the evidence (D-024).

There was a timing trap here. Imagine the stop and the late reading arrive at the same moment on
two connections. The stop reads the readings, and at the same time the late reading is being
saved. Each could miss the other. The fix has two parts. The late reading is saved and committed
first. Then we lock the session's row in the database before checking it. Whatever the timing,
one of them always sees the other. A test runs this race 20 times.

**The frame log and replay:** the gateway now records every message in and out, in a table
called `ocpp_frames`. With that recording, we can **replay** a charger's messages into an empty
database and check that we get the same bills. This matters because a seed only fixes _what_ the
chargers do. It cannot fix the exact timing of the network. The recording captures the timing
that really happened (D-023).

**The best bug of this milestone:** the first replay got almost every bill wrong. The reason:
the recorded messages carry transaction IDs from the original database. A new, empty database
gives out its own IDs, in a different order. So the replayed stops attached to the wrong
sessions. The fix: read the server's original answer to each StartTransaction, and translate old
IDs to new IDs during the replay. This is a general lesson: **if the server assigns IDs, a replay
must translate them.**

**Results** (full details in [results/m2-billing-under-faults.md](results/m2-billing-under-faults.md)):

| Seed | Sessions | Late starts | Lost answers | Discrepancies | Lost or invented | Replay mismatches |
| ---- | -------- | ----------- | ------------ | ------------- | ---------------- | ----------------- |
| 1    | 500      | 41          | 683          | 0             | 0                | 0                 |
| 2    | 500      | 47          | 656          | 0             | 0                | 0                 |
| 3    | 500      | 52          | 628          | 0             | 0                | 0                 |

Running seed 1 a second time gave exactly the same counts and the same energy totals. Only the
time changed.

**What the results do not show (yet):** there was only one gateway, and it never crashed. Crashes
come in Milestone 3.

**What I learned:**

- A test that injects faults must also prove the faults happened. Our tests check that every kind
  of fault occurred at least once, so a run cannot pass by accident.
- "Zero discrepancies" needs a precise meaning. Ours is: the bill equals what the meter readings
  can prove. Energy hidden by an unreported meter reset cannot be billed by anyone, so we report
  it separately.

---

## Milestone 3: several gateways, crashing on purpose

**Goal:** prove that billing stays exact when the servers themselves crash, and let the backend
send commands to chargers, even when there are several gateways.

### Part 1: crashing gateways on purpose

We now run three gateway programs at the same time. A "chaos" loop picks one at random every 0.5
to 1.5 seconds and kills it with **SIGKILL**. SIGKILL is the hardest way to stop a program: it
gets no warning and no chance to tidy up, like pulling out the power cable. A moment later the
gateway starts again (D-029).

When its gateway dies, a simulated charger notices that the connection broke. It waits a little,
reconnects (perhaps to a different gateway), and sends the unanswered message again. The wait uses
**exponential backoff with jitter**. After each failure the longest possible wait doubles: 50 ms,
100 ms, 200 ms, and so on up to 2 s. The real wait is a random time below that limit. The
randomness matters: without it, all the chargers of a dead gateway would knock on the next one at
exactly the same moment (D-028).

**Two problems we had to solve first:**

1. **The recording had holes.** The frame log wrote messages in batches. A killed gateway lost its
   last batch, so replay would break exactly after a crash, when you need it most. The fix is a
   **group commit**: the gateway sends its answer to a charger only after the log has stored the
   message and the answer. Many connections share one database write, so this adds only a few
   milliseconds. Now, if a charger received an answer, the message is always in the recording. If
   the gateway died before answering, the charger sends the message again, and that copy is
   recorded (D-023).

2. **Crashes could change the scenario.** A charger's random choices all came from one seeded
   stream. But how often a charger reconnects depends on crash timing, which no seed controls. If
   reconnect choices used the same stream, one extra reconnect would shift every later choice. So
   network choices now have their own stream. Running the same seed twice gives exactly the same
   charger behaviour, crashes and all. Only the number of reconnects changes.

**Results** (details in [results/m3-billing-with-gateway-kills.md](results/m3-billing-with-gateway-kills.md)):

| Seed | Sessions | Gateway kills | Reconnects | Discrepancies | Lost or invented | Replay mismatches |
| ---- | -------- | ------------- | ---------- | ------------- | ---------------- | ----------------- |
| 1    | 5,000    | 12            | 377        | 0             | 0                | 0                 |
| 2    | 5,000    | 13            | 421        | 0             | 0                | 0                 |
| 3    | 5,000    | 12            | 392        | 0             | 0                | 0                 |

Running seed 1 again gave the same faults and the same energy, to the watt-hour. Only the
reconnects changed: 377 the first time, 402 the second.

### Part 2: sending commands to chargers

Until now, the chargers did all the talking. A real backend also sends commands. Three examples:

- start a session remotely, as when a driver presses "start charging" in an app;
- stop a session remotely;
- ask the charger to report its status right now.

With several gateways there is a puzzle: a charger's connection lives on only one of them. How
does a command find it? (D-030)

- **A registry in Redis** records which gateway holds each charger's connection.
- **The API**, a new small web service, looks up that gateway and publishes the command on the
  gateway's Redis channel. The gateway sends it to the charger, checks the answer against the
  official schema, and publishes the reply back.
- **If nobody is listening** on that channel, the gateway has crashed, so the API answers "not
  connected" at once instead of waiting.
- **When a charger reconnects to a different gateway**, the old gateway is told to close its old
  socket, so two connections never fight over one charger.

We chose **not** to use a durable queue for commands. A "start charging" command that arrives a
minute late is worse than one that fails, because the driver may already have walked away. So a
command either gets an answer within a timeout, or the caller is told it didn't, and can try
again.

The test for this runs two gateways and the API. The charger is connected only to gateway B. The
test starts a session through the API, stops it halfway, and checks that the session was billed
exactly, with stop reason `Remote`.

### What I learned

- **Crash tests need real crashes.** A polite shutdown lets the program tidy up and hides bugs.
- **A recording that loses data in a crash is useless for crashes.** Making each answer wait for
  the log costs a few milliseconds and buys a complete trace.
- **Keep "what the scenario does" and "what the network did" on separate random streams.**
  Otherwise one unlucky retry changes the whole rest of the test.

### Part 3: the core of smart charging

**The problem.** A car park has a power limit, its "cap". If every car charged at full power,
the site would break that limit. So the backend tells each charger how much it may use, and
changes those limits as cars come and go.

**Two ideas make it safe** (D-031):

1. **Every connector keeps a small safe default, even when no car is there.** Ours is 4,140 W,
   which is 6 A on three phases at 230 V. Why reserve it for an empty connector? Because a car
   can plug in and start drawing that default without asking us first. The rest of the power is
   shared fairly among the cars that want more: in each round, every car still wanting more gets
   an equal share. This is called "water filling".

2. **Change limits in a safe order: decreases first, then increases.** Here is an example. The
   site cap is 18,280 W, with two connectors whose default is 4,140 W each. Car A charges alone
   and gets 14,140 W. Then car B arrives, and the fair split is 9,140 W each.
   - **The safe order:** first tell A to go down to 9,140 W. Only after A's charger confirms, tell
     B to go up to 9,140 W.
   - **The wrong order:** if we raised B first, for a moment A would still draw 14,140 W and B
     9,140 W. That is 23,280 W, far over the 18,280 W cap.

**What if a charger never answers?** Then we don't know which limit it is using, so we count the
higher one. This "worst case" is what must stay under the cap. Increases only use power that is
free even in the worst case.

**How it is tested:** these rules are pure functions, so a property test can throw hundreds of
random scenarios at them. Each has up to 300 events: cars arriving and leaving, answers accepted,
refused or lost, chargers going offline, and leases expiring. After _every single event_, the
worst case must be under the cap. A second test checks that once chargers answer again, every
connector reaches its fair target.

**What I learned:**

- **Safety alone is not enough.** A controller that gives every car zero never breaks the cap,
  but it is useless. So the second test checks that the power actually gets used.
- **Small rules catch real mistakes.** The type checker rejected a TypeScript shortcut
  (a "parameter property") in my test code, because Node cannot run it without a build step.
  That is exactly the rule D-003 set up.

### Part 4: the controller meets the chargers

**What was built** (D-032):

- **A controller service** that runs a loop for one site. Every tick, it reads the site, works out
  fair targets, and sends the next safe changes to the chargers as SetChargingProfile commands.
  They travel through the same command bus the API uses.
- **Simulated chargers that obey limits** the way OCPP 1.6 describes. With no profile, a charger
  uses its default. A profile only applies to the current session. Each profile has a lease
  (`validTo`), and when it runs out, the charger goes back to its default by itself.
- **A recorder** that writes down every limit each charger really applies, with a timestamp. The
  verdict comes from this record, not from what the controller believes.

**Leases: safety that doesn't need the network.** Each limit is valid for 30 seconds, and the
controller renews it when half the time is gone. If a charger loses contact with us, its lease
runs out and it returns to its safe default on its own. Without leases, a charger we can't reach
would keep a high limit forever, and we could never give that power to another car.

**The hardest case: no answer.** When a command times out, we don't know whether the charger
applied it. Maybe the command was lost. Maybe the charger applied it and only the answer was lost.
So the controller counts it as "maybe applied" until its lease would be over. After that, the
charger is on its default whatever happened. The same goes for a connection that closes _after_
the command went out: that is "unknown", not "not connected". I had to fix the gateway's command
code for this.

**A test that failed for the wrong reason.** The first cap test reported a peak of 120,420 W
against a 60,000 W cap. I suspected the controller, but the bug was in the simulator: when a
session ended, the charger didn't record going back to its default, so the recorder kept counting
the old, high limit. When a safety check fails, check the checker too.

**Proving the check can fail.** A test that never fails proves nothing. So the same scenario
also runs with a careless controller that sends every target at once, with no ordering and no
worst-case budget. The recorder catches it going over the cap, so the check really works.

**A result that looked too regular.** Five 1,000-change runs with five different seeds all ended
with exactly 504 arrivals and 496 departures. That looked like a bug, so I investigated before
writing anything down:

- the random generator was fine: over 200 seeds, the spread of results matched the theory;
- the load driver with fake chargers gave different results for different seeds;
- running seeds 2 and 3 again, exactly as before, gave 505/495 and 503/497.

The explanation: an offline spell lasts a real number of milliseconds, so which chargers are
online at each pick depends on timing. A seed fixes the decisions, not the exact timing. The five
matching results were a coincidence. Now I can explain them, so I can report them.

**Measuring usefulness changed the design twice.** A controller that does nothing never breaks
the cap, so every run also measures usefulness: the share of the spare power the chargers were
really allowed to use (D-016). Once the simulated chargers could lose answers, it showed two
problems:

1. **Waiting for answers stalled the whole site.** Each tick waited for every answer, so one
   silent charger held everything up until the timeout. Now ticks don't wait. Answers update the
   controller's beliefs when they arrive, and a late answer to a change it already gave up on is
   ignored.
2. **One of my own rules was too strict.** D-031 said: no increase while any decrease is
   unconfirmed. But a decrease whose answer is lost stays unconfirmed for a whole lease, so the
   whole site froze: 32 seconds in production. The worst-case budget already makes sure no
   increase uses power before it is really free, so the strict rule added nothing to safety.
   Relaxing it raised usefulness from 75–82% to 83–86% on four seeds, and the cap held every time
   (D-033).

**What happens when the controller restarts?** A fresh controller remembers nothing. It believes
every charger is on its default, but a charger may still hold a high limit from before the crash.
If the new controller gave that power to another car, the site would go over its cap. The fix is
simple: a fresh controller sends nothing until one lease (plus the clock allowance) has passed.
By then every old lease is over.

A scripted test shows why the wait is needed. Car A charges alone and gets all the spare power:
21,720 W of a 30,000 W cap. A's charger drops off the network and keeps that limit. The
controller restarts, and car B arrives. Without the wait, the new controller gives B its share
(12,930 W) at once, while A still holds its old limit: 38,790 W in total, far over the cap. With
the wait, the site never goes above 30,000 W. My first try at this test used random restarts
instead, and it caught the bug in only 6 runs out of 10. A test that catches a bug "usually" is
not good enough, so I wrote the script.

**What I learned:**

- **Leases turn "I don't know" into "I know when it ends".** That is what makes unknown outcomes
  safe.
- **Measure usefulness next to safety.** Both design changes in this part came from the
  usefulness number, not from the safety check.
- **When a result looks too regular, find out why before you report it.** It might be a bug.
  Here it was chance, and now I can explain it.
- **A restart is a fault like any other.** Memory is lost; leases are what make that safe.

The numbers are in
[results/m3-smart-charging-cap.md](results/m3-smart-charging-cap.md).

---

## Lessons that apply to any backend

1. **Save before you answer**, and make every write safe to repeat.
2. **Choose duplicate keys from what the sender controls**, not from what the server sees.
3. **Use integers for money and energy.**
4. **Seeds make scenarios repeatable; recordings make runs repeatable.** You need both.
5. **Prove your faults happened.** A chaos test that injects nothing proves nothing.
6. **Write down decisions and corrections.** Being honest about a wrong turn is more convincing
   than pretending there were none.
