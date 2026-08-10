## 1. No stopping rule: the dangerous consequence and the cheapest compatible guard

The cited result does not justify uncapped multi-day operation. It supports “re-prompting can outperform allowing the model to stop” on one benchmark and fixed model setup. It says nothing about unbounded cost, destructive tool use, or whether the extra prompts remain productive after hundreds of iterations.

The most dangerous consequence is **unbounded autonomous action with no mechanism to distinguish productive persistence from a pathological loop**. That includes spend, repository churn, accidental destructive commands, and repeated changes/reversions. An agent can make superficially different moves forever, so “no exact repeat” is not a solution.

There is also a more immediate contradiction in the described protocol:

- Worker settles and emits a view.
- Supervisor calls `done`, or sends plain text to the human rather than `steer`.
- No directive reaches the worker.
- Therefore no new worker turn starts and no new `agent_settled` event occurs.

That is an operational ending/quiescence caused by the model, not the human. If `done` has some hidden rescheduling behavior, it needs to be specified; it is absent from the loop shown.

### Cheapest guard against a false ending

Make lifecycle state explicit and durable:

- Only `/supervise stop` may transition `active -> stopped`.
- `done` is not a lifecycle action. It is at most a nonterminal completion report to the human.
- While the run is `active`, every supervisor review must result in either:
  1. a worker continuation/directive, or
  2. an explicit `paused-awaiting-human` state—not `done`.

That prevents the model from silently ending the run early. It does not require a budget or cap.

### Can you prevent a runaway without ever stopping or pausing?

No. Not in the general case.

To prevent an arbitrary infinite loop, some component must eventually suppress, pause, rate-limit, or require approval for activity judged dangerous or nonproductive. If it never does any of those, it cannot prevent runaway behavior; it merely observes it.

The cheapest containment compatible with “never end the run automatically” is **capability containment**, not a stopping rule:

- no ambient credentials;
- restricted filesystem and network;
- explicit approval for irreversible or external side effects;
- isolated worktree/container.

That limits damage, but it does not prevent infinite compute or token spend. There is no universal no-cap/no-pause guard that does.

---

## 2. Are the two guards real satisfiable constraints? Can they deadlock?

They are mostly barriers, not competing objectives. But each has a semantic hole.

| Guard | Constraint shape? | Problem | Deadlock/liveness risk |
|---|---|---|---|
| 2a: no `steer` without goal | Syntactically yes: set a goal, then steering is allowed. | `set_goal` can satisfy the barrier by inventing a goal. That defeats its stated purpose of preventing invented work. | No unavoidable formal deadlock because `set_goal` is always available. But there is a practical quiescent deadlock if the supervisor asks the human and the human does not reply: no directive, no next worker event. |
| 2b: no `done` with outstanding work | Yes, as a precondition: outstanding set must be empty. | The outstanding set is only an approximation of reality. A lost result, crashed tool, or malformed record can make it permanently nonempty. | It cannot deadlock `steer`, since steering remains allowed. It can permanently block `done`, producing an infinite nonterminal state. |

### 2a is weaker than claimed

“No steering without a goal” does **not** prevent a supervisor with no real goal from causing work. It can call:

```text
set_goal("Improve test reliability and resolve remaining issues")
```

and then steer aggressively. The guard changes the failure mode from “ungrounded instruction” to “ungrounded goal binding.” Announcing that invented goal to the human does not repair it if the worker proceeds before the human objects.

If a human-confirmed goal is required, then unattended runs with no initial goal necessarily stall. That is not a bug; it is an irreducible ambiguity. The system cannot both refuse invented goals and autonomously infer authoritative user intent.

### 2b is a valid barrier with incomplete evidence

Blocking `done` on a live tool call is correct as far as it goes. But because the tracker is session-local, it is not a correctness proof that no work exists. It is only a proof that no tracked session tool call lacks a recorded result.

Do not describe this as “no work is outstanding.” Describe it as “no tracked session tool result is missing.” Otherwise the API asserts more than it knows.

---

## 3. Six prior instructions do not solve semantic repetition

Persisting the last six instructions is useful context preservation. It is not a repetition control mechanism.

It fails in at least two concrete ways that similarity detection would catch.

### Paraphrase failure

Suppose the prior instruction was:

> Run the full test suite, inspect failures, and fix the most important one.

The supervisor can later issue:

> Independently validate the implementation and address any failing tests before proceeding.

The worker receives the same operational assignment. The six-entry list may make the repetition obvious to a human, but it does not mechanically block it, and the model can rationalize it as phrased differently.

A semantic similarity check could flag these as substantially overlapping directives.

### Seven-step cycle failure

The fixed window permits cyclic repetition:

1. Run tests and fix failures.
2. Review changed files.
3. Inspect TODOs.
4. Recheck requirements.
5. Run lint.
6. Review tests again.
7. Run tests and fix failures.

At step 7, instruction 1 has fallen out of the visible six-item window. A supervisor can loop forever through a set of seven broad directives, each apparently distinct locally.

The deeper issue is that the stored entries are **advisory text**, not evidence of completed work or measured progress. The supervisor needs to know not only “what did I say recently?” but “what new observation makes this instruction justified now?” The current design has no such requirement.

---

## 4. Reading the worker compactor summary can silently produce a wrong view

Reusing the worker’s compactor is a reasonable simplification only if the extension treats the summary as a versioned snapshot with known coverage. Otherwise it can silently combine incompatible state.

Failure modes:

1. **Stale persistence**
   - The worker has performed actions after the last summary update.
   - `agent_settled` fires before the session write is flushed.
   - The extension reads an old on-disk session snapshot.

2. **Coverage gap**
   - The summary covers turns through turn 120.
   - The rendered “last 24 turns” starts at turn 130.
   - Turns 121–129 disappear entirely.

3. **Wrong branch or fork**
   - A compaction summary belongs to a branch that was later abandoned, rebased, reset, or forked.
   - The extension renders a live branch but imports a summary from another lineage.

4. **Summary/model error**
   - The compactor omitted an unresolved failure, incorrectly stated that tests pass, or treated a plan as completed work.
   - A summary is not canonical state; it is model-generated compression.

5. **Schema/version drift**
   - The compactor changes summary format or session serialization semantics.
   - The extension still extracts a field that exists but now means something different.

6. **Partial/corrupt read**
   - The extension reads while the session file is being updated, or parses a partially written entry.
   - “Fail fast” should mean reject this state, not silently use an older-looking interpretation.

7. **Silent truncation**
   - The 15 KB render limit can remove precisely the section that explains current risk: old goal qualification, a key failure, or the start of a long-running task.
   - A truncated view must say what was omitted and through which turn/revision it is complete.

### Minimum checks

The view should carry and validate:

```text
run_id
worker_session_id
branch_id
session_revision / event_sequence
summary_coverage_start
summary_coverage_end
last_rendered_turn
compactor_schema_version
truncated_sections
```

At minimum, verify:

- summary branch/session identity equals the live branch/session;
- summary coverage joins contiguously to the raw post-summary turns;
- snapshot revision is at or after the settled event being reviewed;
- parsing/schema validation succeeds;
- truncation is explicit;
- directive messages are bound to the reviewed `run_id`, branch, and view revision.

On any mismatch, do not invent a fallback view. Mark the view invalid and fail closed on steering until a coherent snapshot exists. That is not defensive compatibility behavior; it is basic protocol correctness.

---

## 5. Most likely multi-day waste modes

These are guesses from the design, not measured probabilities. I am excluding the four weaknesses you explicitly listed; those would otherwise materially affect the ranking.

| Rank | Failure mode | Rough credence | Cheapest discriminating test |
|---|---|---:|---|
| 1 | **Goal-adjacent churn after useful work is complete or blocked.** There is no evidence-based acceptance condition, no notion of “this directive needs new evidence,” and no terminal lifecycle semantics. The agent can keep refactoring, rerunning, re-reviewing, and modifying peripheral code indefinitely. | 45% | Feed a fixture where the stated goal is met and tests are green, then trigger 20 reviews with no new failures or changes. Count directives that request mutating work. If it continues inventing cleanup/review tasks, this is your dominant waste mode. |
| 2 | **Semantic instruction cycling.** The six-item history is easy to evade by paraphrase or a cycle longer than six. Broad instructions such as “review,” “verify,” “continue,” and “fix issues” make this likely. | 30% | Use a seven-round fixture with semantically equivalent but differently phrased worker states. Inspect whether the supervisor emits materially new, falsifiable next steps or simply rotates equivalent directives. |
| 3 | **Steering from a stale or misbound summary/view.** One wrong summary can cause repeated work against already-fixed errors, missed newly introduced errors, or reasoning about a discarded branch. | 15% | Write an integration test that compacts, changes branch/revision/status immediately before `agent_settled`, and asserts that the supervisor receives a view with the exact expected branch ID, event sequence, and coverage interval. |

The remaining 10% is ordinary integration failure and the already-disclosed issues: detached work invisibility, no mid-turn supervision, whole-view context growth, and broadcast delivery.

The whole-view prompt growth deserves special attention even though you already named it: it is not merely a possible waste mode. It is structurally guaranteed to stress context/compaction over a multi-day run. The test is trivial: record serialized supervisor context size and compaction frequency by review number. If the system cannot show bounded retained decision-relevant state after compaction, it is relying on a model to recover from a deliberately accumulating prompt burden.

---

## 6. Against the owner’s preferences: removable complexity and missing correctness

### Complexity I would delete or collapse

1. **`done` as a supervisor action, as currently specified.**  
   It is either:
   - an actual terminal/quiescing action, contradicting rule 1; or
   - merely a status report, duplicating plain text to the human.

   Delete it as a lifecycle primitive. If retained, rename it to `report_completion` and make its nonterminal semantics explicit.

2. **Turn count, unless it drives a concrete visible decision.**  
   With no round cap, no budget, and no stated policy using it, it is telemetry masquerading as control state.

3. **The extension-owned unresolved-error lifecycle, if it is independently tracked.**  
   “Drop an error when the same tool later runs clean” is a small second summarization/state-correlation system. It has ambiguous identity semantics: same tool binary, same command, same target, same environment, same failure? Either derive current failures directly from ordered tool records or let the worker’s existing summary own that claim. Do not maintain a parallel half-summary.

I would **not** delete the persisted six instructions merely because it is imperfect. It is a direct replacement for the deleted supervisor-memory pipeline and is simple. Just stop claiming it prevents repetition.

### Missing correctness hole

The protocol lacks a **durable causal identity and lifecycle contract**.

Every message needs at least:

```text
run_id
worker_id
supervisor_id
branch_id
view_revision
directive_revision
from
to
```

The worker must reject a directive unless:

- it is from its paired supervisor;
- it matches the active run and branch;
- it is causally valid for a current or explicitly acceptable view revision.

Address filtering alone is not enough on a broadcast channel. An old directive can arrive after a branch change; another loaded session can target the worker; a delayed supervisor can steer based on a stale view. Those are not edge-case niceties in a multi-day asynchronous loop. They are protocol corruption.

The other missing contract is equally basic: define exactly what `done`, plain-text replies, invalid views, and no-goal states do to the `active` lifecycle. Right now, the claim “only the human can stop the run” is not established by the event loop shown.