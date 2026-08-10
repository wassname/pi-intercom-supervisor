## Bottom line

The core architectural change is sound: making the supervisor a real, addressable session solves visibility, persistence, phone access, and human interaction much better than a hidden in-memory LLM call.

The exact feature set is not ready for unattended overnight use. The simplification thesis is mostly right, but it conflates three different kinds of old machinery:

1. **State-reconstruction machinery** — safe to delete.
2. **Heuristic policy machinery** — probably safe to delete initially.
3. **Safety/liveness invariants** — not safe to delete merely because the supervisor now has memory.

My estimate:

- **Chance the core two-session design is right:** 80%
- **Chance the feature set is good as it stands:** **35%**

The four changes I would make before trusting it overnight are:

1. Reject supervision without an explicit durable goal.
2. Restore a bounded mid-turn observation path.
3. Reject `done` while children are active and require completion evidence.
4. Stop putting the same worker view into the transcript twice.

---

# 1. UNDERSTANDING

## What the system now does

There are two persistent agents:

- The **worker** performs the coding/research task.
- The **supervisor** watches snapshots of the worker and decides whether to:
  - inject a user-level directive into the worker,
  - declare supervision complete,
  - or send plain text to the human through the phone bridge.

A local broker separates the two sessions and transports snapshots and directives. The supervisor’s own history now contains its previous reviews and steers, so it can theoretically recognize repetition and maintain continuity without reconstructing a structured context from scratch.

That replaces the old architecture’s hidden, stateless analysis calls with a visible, conversational, long-lived control agent.

## What I think you may be misunderstanding

### 1. “A real session remembers for free”

It does not. A real session **stores prior evidence**, but that is not equivalent to reliable state tracking, loop detection, or progress accounting.

The supervisor may have previous steers somewhere in context, but:

- they become increasingly diluted by repeated worker snapshots,
- the model must repeatedly attend over them,
- raw transcript history does not distinguish resolved from unresolved state,
- and probabilistic recall is weaker than a deterministic invariant.

You correctly deleted much of the old machinery, but “the information is in context” is not the same as “the property is enforced.”

### 2. Context-window capacity is not the relevant limit

At the 20-round cap, a 1M-token context window probably will not fill. At approximately 30 KB of transcript growth per round, 20 rounds produce roughly 600 KB of raw transcript, perhaps around 150K tokens.

The problem is **cumulative replay cost and attention**, not immediate overflow. With one full-context inference per round, the repeated input is triangular: roughly 6.3 MB of text-equivalent input over 20 rounds. Tool continuations may make the actual total materially larger. Prompt caching may reduce price, but it does not make duplication semantically useful.

Also, the concern about compaction around round 60 is inconsistent with a hard 20-round cap unless the cap can be bypassed. Compaction is not the near-term issue under the present policy.

### 3. “Done” is currently local idleness, not global completion

Once subagents exist, completion is a distributed termination problem. A parent session being settled does not prove the whole delegated computation is quiescent.

`done` currently means something closer to:

> “The supervisor believes the visible parent has finished.”

It does not mean:

> “The task is complete, acceptance evidence exists, and no delegated work remains.”

Those are materially different contracts.

### 4. Plain text is being used as an implicit control protocol

“Any plain assistant response means escalate to the human” is clever and simple, but it overloads ordinary conversation. It needs at least a clear policy: whether the worker is paused, whether the supervisor remains paired, and what happens when the human does not answer.

### 5. The multi-writer ordering problem is underdescribed

The human and supervisor can both influence the worker. A dangerous race is:

1. Supervisor begins reviewing snapshot N.
2. Human sends a correction.
3. Supervisor finishes its stale turn and publishes a contradictory directive based on snapshot N.
4. The stale directive arrives after the human correction.

The earlier lost-correction bug shows that this is not theoretical. Delivery is fixed, but precedence, cancellation, snapshot versions, and stale-directive rejection are not described.

## A better framing

This is a **closed-loop supervisory control system over an asynchronous actor system**, not merely “two agents chatting.”

The important properties are:

- **Goal integrity:** never operate without an explicit objective.
- **Observation latency:** how long the worker can proceed without review.
- **Control authority:** human corrections must dominate stale supervisor actions.
- **Liveness:** the worker should continue while useful progress is possible.
- **Bounded harm:** spending and wrong-path time must be limited.
- **Completion safety:** no `done` with active children or missing proof.
- **Delivery semantics:** directives need identity, ordering, and acknowledgement.
- **Observability:** failures must be visible before the morning.

The old design mixed all these concerns into elaborate context machinery. The rebuild correctly removed much of that machinery, but it also removed some actual control invariants.

---

# 2. FEATURE SET

## Group-level verdicts

| Group | Verdict | Main reason |
|---|---|---|
| **KEPT** | **Suspect, mostly right** | The primitives are good, but idle-only review and insufficiently guarded `done` are unsafe interpretations of them. |
| **DROPPED** | **Suspect** | Most complexity deserved deletion, but the drop list incorrectly treats safety invariants as memory compensation. |
| **ADDED** | **Suspect** | Human escalation is valuable; the round cap uses the wrong unit, and rereading the same view is demonstrably wasteful. |

## KEPT

| Feature | Verdict | Reason |
|---|---|---|
| Steering as a genuine user message | **Agree** | It gives directives proper authority and leaves an auditable history in the worker session. |
| Review when worker becomes idle | **Suspect as sole trigger** | It is a good safe review point, but it permits unbounded wrong-path execution during a long turn. |
| Supervisor policy prompt override | **Agree** | Research-specific policy is exactly where premature-stopping behavior should be controlled. |
| Persisted state across compaction | **Agree** | Counters and pairing state are protocol state and should not depend on model memory. |
| `done` ends supervision | **Agree with missing preconditions** | The primitive is correct; allowing it without child and evidence checks is not. |

## DROPPED

| Feature | Verdict | Reason |
|---|---|---|
| Stateless context reconstruction pipeline | **Agree** | Rebuilding seven sections every review is expensive machinery once a real session exists. |
| Strict JSON verdict parsing | **Agree** | Tool schemas are a simpler and more reliable action interface. |
| Mid-turn heuristic trigger | **Wrong to drop the behavior** | Overnight, detection latency matters; a worker can spend an hour wrong before settling. The old heuristic implementation need not return unchanged. |
| LLM goal inference | **Agree only if replaced by mandatory explicit goal** | Inventing a goal is worse than failing. The observed no-goal run proves the replacement is currently missing. |
| Four reframe tiers | **Agree** | A persistent supervisor can choose how to reframe without a hand-built escalation ladder. |
| Steer similarity detection | **Agree provisionally** | It is reasonable to remove initially, although model memory is not a deterministic substitute. Instrument repetition before restoring it. |
| Stagnation counters | **Suspect** | The old counters may be unnecessary, but some objective progress signal is still needed to distinguish productive persistence from looping. |
| Structured observation dict on every steer | **Agree** | This is ceremony on the hot path. Do not confuse it with requiring evidence at `done`. |
| Live terminal reasoning widget | **Agree** | The visible real session and phone bridge supersede it. |
| Per-project model config | **Agree** | This is configuration surface without demonstrated task value. |
| Plugin provider API | **Agree** | Clear governance/reuse debt for a research extension. |
| Process-tree subagent detection | **Split verdict** | Dropping brittle process-tree inspection is fine; dropping the **no-active-children invariant** is wrong. |
| Resolved/unresolved error mining | **Suspect but probably acceptable** | The structure was expensive, but unresolved failures can now disappear into truncated or noisy views. Completion evidence should cover the important part. |
| Seven structured context sections | **Mostly agree** | Files, types, commits, and summaries can go. Goal, active children, and proof of completion are not optional context decorations. |

Your hypothesis is therefore directionally right but overbroad. Reframe tiers, the observation dict, widget, provider API, and most structured sections were compensation machinery. Mid-turn visibility and child completion were not.

## ADDED

| Feature | Verdict | Reason |
|---|---|---|
| Persisted hard cap of 20 steer rounds | **Suspect, probably wrong policy** | A spending limit is legitimate, but steer count is neither cost nor elapsed time nor lack of progress. |
| Plain-text escalation through the chat bridge | **Agree** | It directly serves the core use case with almost no new mechanism. It should remain rare and clearly block further autonomous action. |
| Tool to reread the worker view | **Wrong in the current protocol** | The same view is already in the review prompt, and the observed model immediately fetched it again. |

### Most likely dropped feature to be missed

**The mid-turn trigger**, because it creates unbounded detection latency in the common case. The subagent invariant may have higher severity, but it likely fires less often.

I would restore the property as a **maximum blind interval**, not necessarily restore the old confidence heuristic and its machinery. A periodic or event-debounced snapshot while the worker is busy is simpler. Such a review also needs a non-escalating `continue`/`allow` outcome so observing a healthy busy worker does not itself interrupt it.

### Most likely dead weight

**The reread-view tool in combination with embedding the view in every review prompt.**

The capability could still be useful when the human asks the supervisor for a fresh status. The duplication is the dead weight. Choose one primitive:

- send a small “worker settled, snapshot N” event and make the tool the sole view source, or
- include the view and do not expose the reread tool during that review.

Do not routinely do both.

---

# 3. TRUE TO HIS PREFERENCES

## Clear alignments

The following choices strongly match his preferences:

- Dropping compatibility and provider abstractions.
- Replacing JSON parsing with tool calls.
- Removing reframe tiers, widget machinery, and per-project model configuration.
- Throwing on malformed persisted state rather than silently substituting a value.
- Making escalation use the already-existing chat bridge.
- Persisting protocol state instead of hoping compaction summaries preserve it.

## Clear violations

### 1. Starting without a goal is the strongest violation

The system accepted a semantically invalid state and then improvised.

That is exactly the rejected pattern:

> missing value → silently invent plausible fallback

The correct behavior is fail-fast:

> supervision requires a goal or plan; no goal means no pairing and no worker directive.

Goal inference was right to delete. Goal validation was wrong to omit.

The plan file is not sacred as an implementation, but a durable explicit goal source is mandatory. Given the requested design and his preference for proof linked to files, a required plan file containing objective and UAT is a particularly good fit.

### 2. `done(reason)` does not meet his proof standard

He explicitly wants UAT backed by a file or table, not “I did it.”

A free-form reason permits exactly that. `done` should minimally require:

- zero active children,
- a goal/acceptance criterion reference,
- and evidence references such as test output, result table, commit, or artifact path.

That is not the old structured-observation bureaucracy. It is a completion contract.

### 3. The arbitrary 20-round cap is a new hyperparameter

There is no evidence that 20 steers corresponds to:

- an acceptable dollar budget,
- an overnight duration,
- lack of progress,
- or a meaningful experiment boundary.

It penalizes productive and unproductive rounds equally. One worker turn can spend hours or launch expensive subagents, while 20 short productive rounds may be cheap.

### Does the cap violate “no defensive programming”?

**No, not merely by existing.** A hard resource boundary is domain policy, not defensive fallback behavior. Throwing on a malformed cap is also consistent with fail-fast engineering.

But **this particular cap is still poorly aligned** because it uses an arbitrary proxy and may cause the exact premature stopping he has measured as harmful.

### Is it a satisfiable constraint?

A real cost or wall-clock budget can reasonably be framed as a constraint:

> continue optimizing the task while cumulative spend remains below the boundary.

A steer-count ceiling is a weak proxy for that constraint. It does not “shut off when satisfied”; it monotonically consumes an arbitrary allowance regardless of progress. It is closer to a competing stopping objective.

I would replace it with a hard cumulative resource budget—preferably actual worker-plus-supervisor cost/tokens, with wall time as a secondary bound. At the boundary, page the human and pause. If usage is unavailable, the 20-round cap is defensible only as a temporary fuse, not as the final feature.

### 4. Idle-only review conflicts with autonomous overnight work

“Do not bother me; keep making progress” requires the supervisor to detect catastrophic drift while progress is still occurring. Waiting until the worker stops makes the supervisor reactive after the expensive part has happened.

### 5. No active-child invariant permits unsupported declarations of success

This violates both research reliability and proof-based completion. A parent looking complete while delegated experiments still run is an invalid success state.

## Governance-debt smells

The clearest ones are:

1. **Delivering the same view twice.**
2. **An arbitrary persisted steer-count policy.**
3. **Using plain assistant text as an overloaded escalation state without an explicit acknowledgement or block state.**
4. Any attempt to restore the old seven-section context engine wholesale.

The broker and second session are not governance debt; they directly buy the required visibility and phone bridge. The duplicate context and arbitrary policy state do not.

---

# 4. BUG / FAILURE MODE

Here are my competing hypotheses for how the current loop wastes a night or money:

| Failure mode | Credence | Why |
|---|---:|---|
| Missing, ambiguous, or stale goal causes plausible but irrelevant work | **28%** | It already happened once, and the system did not fail fast. |
| Worker takes a long wrong path before the next idle review | **25%** | Detection latency is unbounded by design. |
| Premature termination through `done`, the 20-round cap, or active-child blindness | **22%** | All three create false completion or forced stopping. |
| Repeated snapshots and tool rereads waste supervisor tokens and degrade attention | **15%** | The cost grows approximately quadratically with rounds even before context fills. |
| Message ordering/delivery race causes a stale steer to override a human correction | **10%** | Two agents plus a human create multiple concurrent writers, and delivery has already failed once. |

Conditional on enforcing a required goal, **mid-turn blindness becomes the most likely failure**.

## Cheapest discriminating test

Build one accelerated “night in two minutes” UAT using a real supervisor model and a scripted worker with five phases:

1. Start with no goal.
   - Expected: immediate hard failure; no worker message.

2. Give a goal, then keep the worker busy while it visibly pursues a wrong objective.
   - Measure time until the supervisor can observe and interrupt it.

3. Mark a delegated child active while the parent appears complete.
   - Expected: `done` is rejected.

4. Produce small, valid progress for 21 settled rounds.
   - Observe whether the cap kills productive work.

5. Use 15 KB snapshots and have the human correction arrive while a supervisor review is in flight.
   - Measure input tokens and verify that the human correction wins over the stale directive.

This discriminates the major hypotheses much better than another broker unit test. The trajectory suggests the present tests emphasize protocol plumbing and generated sessions, not real transcript growth or long-horizon control behavior.

---

# 5. ODDS, GAPS, AND OPEN QUESTIONS

## Calibrated odds

**35% chance that this is a good feature set as it stands.**

Reasons it is not lower:

- The core architecture serves the actual human use case.
- End-to-end transport works.
- Most deletions were healthy simplifications.
- Real sessions are substantially more usable than a hidden supervisor.

Reasons it is not higher:

- It accepts supervision without a goal.
- It has unbounded mid-turn blindness.
- It can declare completion with active delegated work.
- Its stopping budget uses the wrong unit.
- It duplicates the dominant context payload.
- It does not describe ordering between human corrections and stale supervisor decisions.

With the four changes listed at the start, I would move to roughly 70–75%.

## Missing metric/log line

I would emit one canonical line per decision:

```text
supervision_decision
pair_id=...
goal_hash=...
snapshot_seq=...
snapshot_age_ms=...
worker_busy_ms=...
active_children=...
view_bytes=...
view_reads=...
cumulative_input_tokens=...
cumulative_cost=...
progress_evidence=...
action=steer|done|escalate|continue
directive_seq=...
delivery_ack=...
```

The two most important alerts derived from it are:

- **maximum worker-busy time without supervisor observation**, and
- **cumulative cost per accepted UAT/progress delta**.

Without `snapshot_seq`, `directive_seq`, and acknowledgement, a stale or lost correction can fail silently while both sessions look healthy.

## What you are fooling yourselves about

1. **“Memory replaces machinery.”**  
   Memory replaces context reconstruction. It does not replace invariants, delivery ordering, or objective progress measurement.

2. **“A 1M context makes accumulation acceptable.”**  
   Capacity is not cost, latency, or attention quality. At 20 rounds, overflow is unlikely; repeated input is still wasteful.

3. **“The round cap bounds money.”**  
   It bounds successful steer calls. It does not bound the cost or duration of a worker turn, subagent work, or supervisor tool loops.

4. **“Idle means safe to assess completion.”**  
   It means the visible parent is not currently taking a turn. It says nothing about delegated work.

5. **“Plain text gives a complete escalation path.”**  
   It gives transport to the phone. It does not by itself define pause semantics, acknowledgement, timeout behavior, or precedence over stale directives.

6. **“Twenty tests and end-to-end success validate overnight behavior.”**  
   They validate plumbing. The hard failures here are policy, long-horizon cost, and concurrency failures.

## Important questions you did not ask

### 1. What exactly is the completion contract?

What goal, UAT, artifact, or table must exist before `done` is legal? This should be explicit and machine-checkable at least at the level of required evidence references.

### 2. Who wins when messages race?

Human correction should dominate any supervisor decision based on an older snapshot. That likely requires snapshot/message sequence numbers or cancellation of the in-flight supervisor turn.

### 3. What is the maximum acceptable blind interval?

Without an answer, “review only when settled” quietly permits arbitrarily expensive drift.

### 4. What does the 15 KB view omit?

If it truncates the goal, early failures, or delegation state, then the supervisor’s apparent continuity depends on old noisy transcript entries surviving attention and later compaction.

### 5. What happens after escalation or cap exhaustion?

Does the worker pause? Does pairing remain active? Can new views repeatedly page the human? Can a phone correction resume work? This state transition should not be implicit.

---

## Final recommendation

Keep the two-real-session architecture and most of the simplification. Do **not** restore the old supervisor wholesale.

Make five narrow changes:

1. Require an explicit goal/plan and fail before pairing if absent.
2. Add a bounded busy-worker observation path with a non-interrupting `continue` decision.
3. Make `done` illegal with active children and require UAT/artifact evidence.
4. Deliver each worker view only once per review.
5. Replace the 20-steer policy with an actual resource boundary, or clearly label it a temporary emergency fuse.

That preserves the researcher’s preference for a small number of general primitives while restoring the properties that memory alone cannot provide.