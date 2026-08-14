# Research journal

## 2026-08-11 -- what wassname wants from a supervisor, and what he does not

This entry records the design preferences behind pi-intercom-supervisor, so a later reader does not
re-litigate settled choices. The extension pairs two pi coding-agent sessions: a worker that does
the work, and a supervisor that watches the worker and sends it instructions. Everything below
comes either from wassname's standing instructions file or from him in the session of 2026-08-10
and 2026-08-11, and each source is named in the sentence.

### Standing preferences, from his AGENTS.md

His instructions file states the general stance in the section headed IMPORTANT:

> this is fail fast research code, we want breaking changes to gain simplicity. no opt in! no
> defensive programing, no legacy, no backward compat, no fallback

and on complexity:

> Avoid adding losses, models, hyperparameters without removing equivalent complexity. Seek to
> simplify not add. If you add something, you must remove something else of equal complexity.

and on secondary objectives:

> Anything secondary should be a satisfiable CONSTRAINT (barrier penalty that shuts off when
> satisfied), not a competing objective.

His own supervisor policy file, at `~/.pi/profiles/autoresearch/SUPERVISOR.md`, rejects early
stopping and cites a measurement for it:

> The built-in prompt said to prefer stopping over "looping forever chasing perfection". That is
> wrong here. Measured result: at a fixed model, scaffolds that keep re-prompting scored 8.7% on
> MLE-bench against 0.8% for scaffolds that let the model stop (arXiv:2410.07095). Premature
> stopping is the failure mode we are trying to prevent.

### Preferences stated in this session

On the purpose of the rebuild, correcting me after I had described the phone link as the goal:

> na it was to simplify which I think you have done

On stopping rules, after I added a cap of twenty steer rounds and after two external reviewers
recommended replacing that cap with a spend budget:

> no! bad
> I want no budget at all! I want long until human stops

On the length of a supervision run, when I described the worker view as the last twenty four turns:

> hmm it's for logn day long many day tasks so I'd rather make sure supervision doesn't stop after
> N turns?. and doens't VCC have a better summary than last 24 turns? and should it not be
> compaction + N turns

On specific features he approved dropping: the four escalating rephrase levels ("fire") and the
strict JSON verdict replaced by a tool call ("good"). On one he requires: detection of delegated
work still running ("need"). On one he wants kept: inference of the goal at startup ("it's good").
On one he doubts my reasoning: the stagnation counters, where he asked "you think supervisor
understand now and doesn't need it?".

On repository hygiene he rejected three things I had committed: a copy of one of his real pi
session transcripts used as a test fixture, a directory of my own run logs, and my working notes
directory. On reporting style he twice rejected a feature comparison table as too long to read and
asked for short plain English.

### My reading of these, labelled as mine

My read is that a single principle explains all of the session preferences: the supervisor exists
to stop a run ending early, so any mechanism that can itself end a run early is the opposite of the
feature. I hold this *probable*, around 0.85, because it predicts the cap rejection, the multi-day
framing, and the SUPERVISOR.md quotation independently, and because he rejected the cap even after
two external models argued for replacing it rather than removing it.

That reading also resolves an apparent conflict with his no-defensive-programming rule. The oracle
review argued that a resource bound is domain policy rather than defensive fallback, which I agree
with, so the cap was not wrong for being a guard. It was wrong for being a competing stopping
objective in a system whose one job is not to stop.

A second reading, held less firmly at about 0.6, is that his "compaction plus N turns" request is
not a request to port the VCC summarisation pipeline into this extension. Real pi sessions already
store the summary written by whichever compactor the worker runs, in an entry carrying a `summary`
field. Reading that field gives the view a summary of everything older than the recent turns, and
it gives VCC's summary automatically when VCC is the compactor. If that reading is wrong, the
alternative is a real dependency on a summarisation library, which his copy-paste-over-dependency
rule would count against.

I am least confident about the stagnation counters, maybe 0.5. I claimed the supervisor no longer
needs them because it remembers its own past instructions, but that memory lives in its transcript
and a compaction can remove it, which is exactly what happens on the multi-day runs he described.

The practical takeaway is that this extension should run until a human stops it, should summarise
rather than truncate, and should keep only the guards that prevent a false ending.

## 2026-08-11 -- both of my hedged readings were wrong, and how the tests hid it

Later the same day wassname answered the two questions the entry above left open, and a fresh-eyes
pass then found that two of the features I had just claimed to build did not work. This entry
records what the evidence turned out to be.

On the first reading, held at about 0.6, that his "compaction plus VCC" request did not mean
importing a summarisation library: he answered "yes vcc". The cost I had priced in was wrong.
pi-vcc's own README says it is an "Algorithmic conversation compactor ... No LLM calls", and its
`compile()` is an ordinary exported function, so the dependency is a pure function call rather than
a pipeline to port. Taking it removed the hand-written file tracker, noise filter and transcript
renderer, so `src/view.ts` came out shorter than it went in.

On the second reading, held at about 0.5, that the supervisor no longer needs stagnation detection:
he asked for it, and an independent review had already ranked it. gpt-5.6-terra put "semantic
instruction cycling" at 30% of multi-day waste, and observed that a window of six remembered
instructions cannot stop a seven-step cycle, because at step seven the first has fallen out of the
window. My interpretation, which I hold firmly, is that I was reasoning from what the supervisor
could in principle notice rather than from what its context actually retains.

The part worth remembering is how the first implementation failed. A subagent with no context was
asked to refute four claims by mutating the production line each test targets. Deleting the one
line that sends an inferred goal to the worker left all 41 tests passing, because the test had
hand-delivered the wire message itself and never called the tool. Separately, the stagnation
counter read pi-vcc's rendered file list, which stops at ten paths and appends "(+N more)", so its
probe showed `n=10 -> n=11: FROZEN (new file invisible)`: the counter went blind on exactly the
long runs it exists for, and no test noticed because no test had more than a handful of files.

My reading, at about 0.85, is that a test written alongside the feature tends to assert the shape
the author had in mind rather than the behaviour, and that mutating the line under test is the
cheapest way to tell those apart. It cost one subagent and found two real defects that four
external model reviews had missed.

The measurements from this round, for anyone tuning them later: word overlap between one
instruction and a rewording of it is about 0.44, against under 0.2 for two different instructions
and 0 for a paraphrase sharing no vocabulary, so the 0.4 warning threshold is a floor on repetition
and not a bound. The whole loop now rests on evidence the supervisor can see rather than on rules
that stop it, which is the shape wassname asked for.

## 2026-08-14 -- one fact about how a turn ends caused four separate defects

wassname ran the pairing overnight, supervisor session `019ffa73` and worker session `019ff807`,
sixteen hours on deepseek-v4-pro both sides, and asked me to audit it. The pairing worked: 23 steers
all landed in the worker as role `user`, and the supervisor's judgement was better than I expected
it to be. It pushed cheap CPU tests ahead of 40 minute GPU runs, it accepted being overruled by the
worker's own data ("worker ran a clean sensitivity sweep and chose dyn_d=0.01 ... over my 0.1
suggestion"), it caught the worker ignoring wassname ("The human asked "collinear?" and you have not
answered, this is the third time"), and it refused to call the goal met at a milestone that looked
like one. Goal C in the plan asked for a real overnight run to see whether its judgement was any
good, and this is the evidence for it.

The four defects I found all trace to a single fact about pi, and I record it here because I did not
know it when I wrote the prompts. A turn ends only when the assistant writes text and calls no tool.
A tool result therefore reads as a prompt to act again, and a result that does not name the exit
leaves another tool call as the only move the model has. Each defect below is that fact meeting a
different piece of wording.

The `let_it_run` result used to end "Say nothing more until the next view arrives", which forbids
the exit outright. Session `019ffa73` answered with a second `let_it_run` and aborted on it sixteen
times before 11:05Z, which is every look in that window. The second call is a sign-off, not a loop: the first
reason is true ("job 23 progressing normally, 438/600 steps") and so is the second two seconds later
("waiting for job 23 to reach Evidence-b"). I fixed the wording, and the `steer` result then showed
the same shape for the same reason, a spare `let_it_run` on 22 of 22 steers in the fifteen hours
after. Both results now carry an explicit `END_TURN`. Honest note against my own fix: at 04:29:43Z,
with the new `STEER_ACK` live, the supervisor still called a spare `let_it_run` and read "Already
recorded". So naming the exit reduced this rather than removing it.

Two measurements from that session are worth keeping. Cost: the worker spent $16.11 over 789 model
calls and the supervisor $0.38 over 182, about 40x less, because the supervisor reads a lot, writes
almost nothing, and most of what it reads is a cache hit at $0.004/Mtok against $0.44/Mtok for fresh
input. That is what makes a frontier model affordable on the watching side. Context: it grew 37.9k
to 234.7k tokens with zero compactions, and by character count the last look was 56% stale view
bodies and 32% stale thinking against 7% its own verdicts. The verdicts are the part worth keeping,
because they are already the supervisor's running notes on the worker, e.g. "job 26 Evidence-b
partially landed: post rho 0.726 > prompted 0.718 (was tied before rebuild), probe d flipped
+0.059". Pruning the rest before each model call holds the context near 25k on a replay of that same
session, 82% off at the last look. `scripts/measure-prune.ts` runs the replay so the number is
measured rather than asserted.

The fourth defect was mine, and it is the one that cost wassname his morning. `agent_settled` ran
`clearInterval(watchTimer)` with the comment "the worker stopped, so there is nothing to watch until
it starts again". The reasoning is wrong in a way I still find slightly startling: a stopped worker
cannot change, so watching it looks pointless, but a stopped worker is exactly the state that needs
an instruction. On 2026-08-14 the worker's last message was 02:02:18Z and the next entry in that
session is wassname typing "why stop" at 04:29:14Z, 2h27m later. The supervisor saw the stop one
second after it happened and answered `let_it_run`, "human is actively directing ... Waiting for the
worker to re-queue in the main group". Nothing was going to re-queue. `let_it_run` means do nothing,
doing nothing is what a stopped worker does, and with the timer off there was no third thing left to
wake either side.

wassname corrected my reading of that reason, and the correction is the useful part. I had treated
"human is actively directing" as sensible; he said "err no if I send a message it doesn't mean the
supervisor should stop, I will stop them if I need to". A human message is not a handover. He says a
word and goes to bed, and the worker stays stopped with nobody driving it, which is the precise
state the supervisor exists for. The stand-down is now denied in three places, one of which is the
`let_it_run` tool description, because that is the only one of the three a supervisor compaction
cannot lose.

He also asked for a wall-clock measure: "maybe it should go after N minute with not turned, and be
clear there have been no turns for this long, is it stuck". The status line used to carry seconds
since the last look, which measures the supervisor rather than the worker and understates a worker
that stopped hours before anyone looked. It now carries `sinceLastTurn()`, measured from the
worker's own last session entry. One number covers both ways of being stuck, sitting at the prompt
and hanging inside a command that never returns, since neither writes an entry. It lives in the
status line rather than a new header line because `bodyOf` strips that line, so a clock that moves
on its own cannot defeat the unchanged-view skip.

Two smaller things I would tell a later reader. The session jsonl timestamps are UTC and this
machine is AWST, so a session that looks eight hours stale is current; I nearly reported a live
pairing as dead over it. And `errorMessage` lives at `.message.errorMessage`, not `.errorMessage`,
so my first jq pass returned zero aborts for a session that a raw `grep -c aborted` put at sixteen.
Both are the same failure: an empty result from a query I had not validated, read as a fact about
the world.
