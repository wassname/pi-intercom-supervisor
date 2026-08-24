I'll start by inspecting the uncommitted diff and the surrounding tests for the long-goal delivery policy.I have the repo context. Next I’ll inspect the uncommitted diff and the tests that cover long-goal delivery.I only have file reads here, so I’ll reconstruct the uncommitted change from git metadata and the source/tests around long-goal delivery.HEAD is one commit ahead of origin. I’ll compare working-tree sources against that commit and inspect the long-goal tests.HEAD is one commit ahead of origin. I’ll now compare the working tree against that commit and inspect the long-goal tests.The commit log is in place. Next I’ll walk the remaining source and tests that implement the long-goal cadence.I have the current implementation. Next I’ll compare it with HEAD/origin and check the compaction-event timing.I’ll inspect git history, compaction-event semantics, and any docs that may have drifted from the new policy.I need the `session_compact` timing from pi’s extension docs, plus any remaining tests around goal change and reload.I’m checking pi’s compaction hook timing and whether the working tree differs from HEAD in the goal-delivery files.I’ll look at the compaction source and remaining tests around goal-change, reload, and documentation.I need the exact compaction event order and whether `session_compact` happens before or after context is rebuilt.I need to inspect how pi actually rebuilds context after compaction, and whether `session_compact` is the right hook for reinserting the goal.I’ll inspect how `sendMessage` works and whether compaction actually drops custom messages like the brief.I still need to check whether compaction actually drops custom messages, and whether `set_goal` or reload inserts the full multi-line goal.I’ll inspect compaction source and remaining tests around goal-change, reload, and documentation.I need the exact compaction rebuild path. I’ll look at pi’s source around `session_compact` and custom-message handling.I’ll inspect session-manager message conversion and how custom messages survive compaction.I need `sessionEntryToContextMessages` and `buildSessionContext` to see whether custom goal messages survive compaction.I need `buildSessionContext` and `sessionEntryToContextMessages` specifically.I still need `sessionEntryToContextMessages` and the compaction hook implementation.I’ll look at `sessionEntryToContextMessages` and how `session_compact` is emitted in the agent session.I found that custom messages do enter LLM context. Next I’ll inspect when `session_compact` fires relative to context rebuild.I need the `compact()` method itself, not the extension binding.I need the `_checkCompaction` / `compact` path specifically.I have the compaction timing. I’ll now check the remaining auto-compaction path and whether custom messages survive the cut.I need `sendCustomMessage` to confirm whether a compaction-time goal insert can start a turn.## Findings

**1. `@worker` pairing flattens multi-line goals, so BRIEF and cadence never see the rubric.**

```744:761:src/index.ts
      const [first, ...rest] = text.split(/\s+/);
      // ...
      if (first.startsWith("@")) {
        // ...
        goal = readGoal(context.cwd, rest.join(" "));
```

`\s` eats newlines, then `join(" ")` makes a one-line goal. After that:

- `BRIEF` stores the flattened text (`src/prompts.ts` 44–50, `src/index.ts` 813)
- `goalPreview()` treats it as a one-line goal and prints it verbatim (`src/view.ts` 164–169)
- `tellGoal()` no-ops because `!state.goal.includes("\n")` (`src/index.ts` 237–240)

The new cadence test pairs with `@worker ${multiLineGoal}` and then expects a later insert containing a real newline (`src/index.test.ts` 452–458, 466). That path cannot produce that string. File goals still work (`/supervise @worker docs/GOAL.md`) because the path is one word. Bare `/supervise` also keeps newlines (`src/index.ts` 763). `/supervise goal` keeps them too (`src/index.ts` 710). Only the `@target` parser is wrong.

**2. Pair is published before BRIEF, so the first review can run with only the locator.**

```798:813:src/index.ts
      send({ t: "pair", to: state.pairedId, goal });
      // ...
      tellSupervisor(BRIEF(prompt, goal, target));
```

The worker publishes a view immediately on pair (`src/index.ts` 418). That view now carries only `first line [...]` (`src/view.ts` 274–277). Reload and goal-change do this in the safe order (insert, then `look`: `src/index.ts` 347–351 and 724–727). Pairing does not. If the pairing view wins the race, the first supervisor turn starts from the locator and no rubric.

**3. `session_compact` inserts the goal after context rebuild and can break overflow recovery.**

Pi rebuilds `agent.state.messages` from the compaction entry, then emits `session_compact` (`agent-session.js` around the `appendCompaction` / `buildSessionContext` / `emit("session_compact")` sequence). Overflow retry then strips a trailing assistant only if it is still last:

```
lastMsg?.role === "assistant" && (stopReason === "error" || "length")
```

`tellGoal()` appends a custom message after that rebuild (`src/index.ts` 237–240, 523–525; `sendCustomMessage` else-branch pushes onto `state.messages`). The failed assistant is no longer last, so it is not removed. The retried turn keeps the truncated/error reply, and the new rubric sits after it. The harness `compact()` helper never rebuilds context or retries (`src/index.test.ts` 175–177, 469–472), so this is untested.

**4. Stale / misleading docs around cadence.**

The new policy paragraph ties worker compaction to “the count”:

```112:116:README.md
A one-line goal repeats in full. A multi-line goal shows its
first line with `[...]`; its complete rubric enters the supervisor context at pairing, goal change,
reload, compaction, and before every fifth review. A worker compaction restarts the count, and the
view says so and carries the summary.
```

Worker compaction restarts the view window (`sentTurns` / `since` in `src/view.ts` 268–271), not `reviewsSinceGoal`. Supervisor cadence is only reset by pairing, `/supervise goal`, reload, supervisor compaction, and a successful `tellGoal()` (`src/index.ts` 123, 237–240, 348, 525, 725, 797).

BRIEF still tells the model the rubric returns only “before every fifth review and after compaction” (`src/prompts.ts` 45–46). It omits goal-change and reload, which do re-send the full goal (`GOAL_CHANGED` / `REANCHOR`).

---

## What is correct

- One-line views stay verbatim; multi-line views are first non-empty line + ` [...]` (`src/view.ts` 164–169, 274–277; `src/view.test.ts` 22–32).
- Cadence math is not off-by-one: `reviewsSinceGoal` starts at 0, increments on views 1–4, inserts on the 5th (`src/index.ts` 123, 460–461; `src/index.test.ts` 452–466).
- Full-goal inserts go through `tellSupervisor(..., { triggerTurn: false })` and do not start a turn (`src/index.ts` 233–235, 237–240). Pairing, goal-change, and reload tests cover that for BRIEF / `GOAL_CHANGED` / `REANCHOR` (`src/index.test.ts` 1106–1126, 1128–1144, 748–761).
- `/supervise goal` and reload re-send the complete goal, then ask for a view (`src/index.ts` 724–727, 347–351).
- Supervisor directives are dropped from VCC evidence and do not move the idle clock (`src/view.ts` 44–47, 149–155; `src/view.test.ts` 212–232, 256–268).