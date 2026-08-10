# Design review: pi-supervisor → two-session intercom

## 1. Does the implementation deliver the design?

**Mostly on the core slogan, with several material gaps and one intentional product deviation.**

| Area | Verdict | Why |
|---|---|---|
| Two real sessions + intercom wire | **Delivers (with a wire choice)** | Design said “pi-intercom.” Built on the **extension channel**, not ordinary intercom messages. That is an **improvement** for the stated motive: views/steers stay out of transcripts, do not accidentally start turns, and sender id is broker-stamped. Ordinary chat messages would pollute history and blur the trust boundary. |
| Extension provides view + trust boundary + steer/done | **Mostly delivers** | Three tools (`worker_view`, `steer`, `done`) match the “tiny” intent better than the old pipeline. `worker_view` is a slight expansion of “two verbs” but **neutral/positive**—on-demand refresh without another full settle cycle. |
| Drop heavy context pipeline | **Delivers** | Replaced with a bounded view (goal, status, turn count, ≤12 files, errors/exits, last 24 turns, 15 KB). Good match to “tiny bounded supervisor_view.” |
| KEEP explicit goal, auto-infer, outside observation, steer as real user message, idle check, completion ends, SUPERVISOR.md | **Partial** | Steer-as-user-message: **delivers** (`[supervisor] …`, and busy path `deliverAs: "steer"`). Idle via `agent_settled`: **delivers**. Done ends supervision: **assumed delivered** (not contradicted). Goal handling: **regresses** in behavior (see §4)—auto-infer without a goal became “invent a task,” which is not “infer or ask.” Outside observation / phone escalation via plain text: **delivers** and is elegant. SUPERVISOR.md: not evidenced in the writeup; if present, fine; if not, regression. |
| active_children / no-done-while-delegated | **Not built — regression** | Design kept the invariant and only dropped process-tree inspection. Without `active_children` (or equivalent), `done` can fire while subagents still run. For research agents that delegate, that is a real correctness hole, not a polish item. |
| `.pi/plan.md` as preferred goal source | **Not built — regression** | Design explicitly preferred pi-goals’ plan file. Without it, goal is whatever was typed at pair time or whatever the supervisor hallucinates. Overnight runs often already have a plan artifact; ignoring it forces duplicate goal entry and drift from the worker’s own planning surface. |
| `/supervise` in worker vs supervisor | **Deviation — mixed** | Design’s **final** revision: type in **worker**, which creates/attaches supervisor. Built: two terminals, `/supervise` in **supervisor**, first-pair-wins on worker. **Regression vs final design** for UX (worker-centric start, auto-attach). **Neutral/slight improvement** for the phone story: supervisor session already exists and can be bridged before work starts. **Security/product regression**: first-pair-wins with nothing to authenticate is weaker than worker-originated attach. |
| 20-steer cap | **Added beyond design — improvement with caveats** | Design had no stopping rule; unbounded steer loops can burn money overnight. Persistence across compaction/reload and fail-fast bad config are sound. Whether *20 rounds* is the right mechanism is §2. |
| Pairing / no auth | **Delivers the thin version, design was thin too** | Roster + session id pairing matches “local broker” assumptions. First-pair-wins is a **latent failure mode** (wrong supervisor wins if two try), not called out in design—**design gap**, implementation inherited it. |
| Role decided at runtime, same extension both sides | **Delivers** | Cleaner than two packages. Audience `"capable"` + `to` filter is a bit broadcast-y but workable locally. |

**Bottom line:** The architectural slogan is largely realized. The implementation does **not** fully deliver the design because it dropped `active_children` and `.pi/plan.md`, inverted the final `/supervise` entry point, and left goal-missing behavior unspecified so the model freelanced. The extension-channel wire and steer delivery fix are real improvements over a naive reading of the notes.

---

## 2. Is a 20-round cap the right mechanism?

**Better than