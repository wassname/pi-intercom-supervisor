# Design review: pi-supervisor → two-session intercom rebuild

## 1. Does the implementation deliver the design?

**Mostly the skeleton, with several material gaps and one intentional improvement.**

| Item | Verdict | Why |
|---|---|---|
| Two real pi sessions over intercom | **Delivers, with a wire deviation** | Design said “pi-intercom.” Build uses the **extension channel**, not ordinary intercom messages. That is an **improvement**: views/steers stay out of transcripts and do not auto-start turns; each side owns `sendUserMessage`. Ordinary messages would pollute history and couple turn-taking to the broker. |
| Audience `"capable"` + receiver `to` filter | **Neutral / slightly fragile** | Works, but “broadcast then filter” is weaker than true point-to-point. Roster + session-id pairing mitigates forgeability of sender (broker-stamped); it does not mitigate wrong-session delivery if filtering bugs. |
| Supervisor: read-only + view + steer | **Mostly delivers** | Tools are `worker_view`, `steer`, `done`. That matches the slogan. Whether the supervisor session is actually stripped of write tools is not stated—if it still has a normal coding toolbelt, that is a **regression** on the trust boundary. |
| Drop heavy context pipeline; tiny `supervisor_view` | **Delivers** | Bounded view (goal, status, turns, ≤12 files, errors/exits, last 24 turns, 15 KB) is the right shape. |
| KEEP: explicit goal, auto-infer, observe, steer as user message, idle check, completion ends, SUPERVISOR.md | **Partial** | Steer-as-user-message: **delivers** (and `deliverAs: "steer"` fixed the mid-turn drop). Idle via `agent_settled`: **delivers**. Done ends: **assumed delivers**. Goal path: **regresses**—no `.pi/plan.md`, and “no goal” invented work (see §4). Auto-infer without a “ask human” fallback is half-implemented. |
| Subagent invariant via `active_children` | **Not built — regression** | Design kept “don’t declare done while delegated work is outstanding.” Without it, `done` can fire while subagents still run; overnight runs that fan out work will false-complete. Dropping process-tree inspection was fine; dropping the *invariant* was not. |
| Prefer `.pi/plan.md` | **Not built — regression** | For research runs, plan.md is the durable goal artifact. Relying on `/supervise` text or invention is weaker and drifts from pi-goals. |
| `/supervise` location (worker vs supervisor) | **Deviation — mild regression vs final design** | Final design: type in **worker**, which creates/attaches supervisor. Built: two terminals, `/supervise` in **supervisor**. Loses one-shot attach/UX and “worker owns the run” semantics; gains explicit two-session visibility. For phone bridge, supervisor-centric pairing is defensible, but it is not what the final note specified. |
| Pairing: first request wins, no auth | **Neutral, sharp edge** | Honest given no shared secret. First-pair-wins is attackable on a shared broker machine; for local solo use it is acceptable. |
| 20-steer cap persisted in session entries | **Added beyond design — improvement as a guardrail, wrong as a *stopping policy*** | See §2. Throwing on bad cap at load is good. |
| Escalation = plain text → chat bridge | **Delivers** elegantly; no extra code path. | |
| Branch from `getBranch()` | **Improvement** over naive history; blocks abandoned-fork leakage. | |

**Bottom line:** The architectural slogan is largely realized (agents + wire + view/steer/done). The implementation does **not** fully deliver the design where it matters for correctness of completion and goal sourcing: **no `active_children`, no `.pi/plan.md`, inverted `/supervise` entrypoint, and no disciplined no-goal behavior.** The extension-channel choice and steer delivery fix are real upgrades.

---

## 2. Is a 20-round steer cap the right mechanism?

**No. It is a crude fuse, not a stopping rule for unattended overnight research.**

What a round-cap gets right:
- Bounds worst-case supervisor↔worker thrash and token burn.
- Persisting into session entries so compaction/reload cannot refill is the correct durability move.

What it fails to catch:
- **One steer, huge waste:** a single bad directive can launch a multi-hour training job, data download, or cluster thrash. Round count stays at 1.
- **Progress-free activity:** worker busy-loops on builds/tests/reinstalls without meaningful plan movement; steers may be rare if the supervisor only wakes on `agent_settled`.
- **Supervisor monologues / tool paddling:** `worker_view` spam or long reasoning without `steer`/`done` may not increment the cap (depends on whether the cap counts steers only—as named, it does).
- **Premature stop on legitimate long research:** exploratory ML often needs many small course-corrections overnight; 20 is arbitrary relative to wall-clock or $ budget.
- **Oscillation under the cap:** A↔B thrashing for 20 steers still burns the night, then dies without escalating *why*.
- **No success criterion:** cap does not ask “is plan.md advancing / metrics improving / goal satisfied?”

**Better mechanisms for overnight unattended use** (layered, not exclusive):
1. **Wall-clock and $ / token budgets** on both sessions (hard stop + mandatory human escalate).
2. **Progress signal in the view:** plan checksum / unfinished goals from `.pi/plan.md`, or “no new files & no status change for N idle cycles → escalate.”
3. **Stagnation rule:** same steer embedding/text twice, or steer that restates last steer → escalate, don’t keep steering.
4. **Steer budget as soft warning:** at 50% and 80%, supervisor must summarize and ask phone; hard cap only after that.
5. **`done` gated on invariants** (no active children, goal satisfied or explicit human abort).

A cap of 20 steers is acceptable as a **last-resort circuit breaker**, not as the primary stopping policy. The design’s silence on stopping was a gap; filling it with only a round counter papers over that gap.

---

## 3. Failure modes ranked (waste night / money)

1. **Supervisor invents or drifts the goal (already observed)**  
   Highest likelihood given current behavior. Overnight the worker optimizes the wrong objective for hours. Cost: full run burn + useless artifacts. Root: weak/missing goal binding + no “refuse to steer without confirmed goal.”

2. **False `done` while work continues (missing `active_children` / subagents; also external training processes)**  
   Supervisor sees idle parent trajectory, calls `done`, supervision stops; child agents or detached GPU jobs keep spending. Or the inverse: human thinks it’s done and ignores the phone. Very expensive for ML workloads that shell out.

3. **Steer oscillation / thrash under the cap**  
   Supervisor flip-flops (“try X” / “revert X”) because the view is a 24-turn, 15 KB slice with no plan diff or metric trend. Twenty rounds of thrash can consume a night of coding agent fees without the hard cap ever feeling “safe.”

4. **Context growth / compaction damage on the long-lived supervisor**  
   Every idle cycle injects a full view via `sendUserMessage`. Overnight → huge supervisor transcript → compaction → loss of goal, pairing rationale, prior escalations, “user said Cthulhu.” Supervisor then re-invents strategy. Worker compaction is similar: steers remain as user messages but the evidence they referred to vanishes, so the worker “complies” with a steer against forgotten context.

5. **Idle deadlock / missed wakeups**  
   If `agent_settled` is skipped (crash mid-turn, stuck tool, waiting on user input in worker, broker drop), neither side advances. Less subtle variant: supervisor waiting for a view that never comes after worker reload; or worker paired but supervisor session died—worker runs unsupervised for hours while user thinks the phone bridge is armed.

6. **One-side crash / reload unpaired**  
   First-pair-wins with no re-auth or session continuity story: worker restart may ignore supervisor’s re-pair; supervisor restart may lose cap/goal/state unless fully in entries. Unsupervised burn or stuck pair.

7. **View truncation hiding the real failure (15 KB / 24 turns)**  
   The smoking gun (failed eval metric, OOM tail, wrong dataset path) falls off the window; supervisor steers cosmetically. Silent quality failure more than instant money fire, but common in long runs.

8. **Human correction path still partial**  
   `deliverAs: "steer"` fixed busy delivery; plain-text phone replies that are *not* framed as goals/steers may still be ambiguous (chat vs directive). Lower than the above if the user only talks when pinged.

Mutual wait is real but secondary to **wrong-goal** and **false-done** for this use case—those two specifically destroy unattended research value.

---

## 4. No goal: what SHOULD happen?

**Concrete rule:**

- If no goal is provided on `/supervise` **and** `.pi/plan.md` (or equivalent pi-goals artifact) is missing/empty/unparseable, the supervisor is **forbidden** from calling `steer` or `done`.
- It must **escalate once** in plain text (phone-visible) with a fixed prompt: state that supervision is armed but idle, ask for the goal (or confirmation to use plan.md), and list what it can see (worker name/id, branch tip).
- While goal is unset, the worker may continue local user work **unsteered**; the supervisor only publishes/acks views and replies to the human.
- Goal becomes set only by: (a) explicit human message, (b) successful read of `.pi/plan.md` with a one-line confirm escalate (“using plan.md title/goal X—reply abort to stop”), or (c) `/supervise …` args.
- **Auto-infer** is allowed only as a *proposal* to the human, never as a silent bind. Inventing a task for the worker is a spec violation.

That matches the motive (interrupt only when blocked) better than inventing work: **no goal is a block.**

---

## 5. Which NOT BUILT item matters most?

**`active_children` / “don’t done while delegated work outstanding” matters more than `.pi/plan.md`.**

Why: `.pi/plan.md` improves goal quality; without it you still have `/supervise <goal>` and human text. Without the subagent invariant, **`done` is a lie** precisely when the worker did the scalable thing (delegate). For overnight ML, “delegated” also means long `pip`/`train`/`sweep` children. Supervision ends, bridge goes quiet, GPUs stay hot—or the parent idles while children fail unobserved. False completion is a **safety/correctness** bug; missing plan.md is a **goal-sourcing** bug. Fix completion first.

(If forced to rank the `/supervise` entrypoint deviation: lowest impact of the three; annoying UX, not silent corruption.)

---

## 6. Missing features both design and implementation overlooked

Only real ones for **unattended overnight ML from a phone**:

1. **Budgets and heartbeat escalation (wall-clock, tokens/$, and “last progress at”)**  
   Phone should get a periodic digest or a ping when no meaningful progress occurs—not only when the LLM chooses plain text. Without this, silent stuck or silent spend is the default failure.

2. **Durable run binding: goal + worker session id + experiment identity survives reload/compaction**  
   Pairing and goal should rehydrate from session entries/artifacts with explicit re-pair; steers should reference a goal checksum. Otherwise crash/reload mid-night unsupervises or re-invents. (Cap persistence shows they know the pattern; they didn’t apply it to goal/pair.)

3. **External/long subprocess awareness beyond pi subagents**  
   Research workers launch training jobs, tmux, or background shells that outlive `agent_settled`. View needs “outstanding non-session work” (or a convention: worker must record PIDs/job ids in plan/status). Otherwise settled≠safe and done≠done.

(I am not padding with nice-to-haves like fancy widgets; those three are the ones that actually protect an overnight phone-supervised run.)

---

**Summary judgment:** The rebuild hits the right architecture (real supervisor session, extension channel, tiny view, steer as real user message, phone escalate by ordinary reply). It is not yet trustworthy for the stated use case: **goal can be invented, done ignores outstanding work, stopping is a steer counter, and overnight silence/spend has no heartbeat or budget.** Ship blockers before more polish: no-steer-without-goal, `active_children` (and external job hooks), progress/budget stop rules, durable pair+goal state.