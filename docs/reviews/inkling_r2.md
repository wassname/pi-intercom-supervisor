## Code Review: second pass (re-read after fixes)

### Summary
`vccSections` now handles all four output shapes correctly (headers+brief, headers only, brief only, neither). The pairing timer is cleared in the `pair` handler, so a healthy acknowledgment no longer dies to a stale timeout. One interleaving remains: `done`/`unpair` in `onWire` does not verify the sender, so any session (including an old worker that switched away) can reset the supervisor and end a live run unexpectedly.

### Critical (must fix)
- `src/index.ts:143-145` (`wire.t === "done" || wire.t === "unpair"`) No `from !== state.pairedId` guard. After a takeover (`pair` from a new supervisor sends `unpair` to the old one), the old supervisor resets correctly; but the reverse also holds: an old worker that sends `unpair` (because it paired with someone new) hits a supervisor that has since moved on to a different worker (`state.pairedId` is the new one), and the supervisor resets, ending a run the human did not end. Add `if (from !== state.pairedId) return;` before the `reset()` for these two types.

### Important (should fix)
- `src/index.ts` pairing interleaving: the new `clearTimeout(pairTimer)` in the `pair` handler fixes the case where a delayed `paired` arrived after the supervisor had already moved on. The 10-second timeout, last-pair-wins, and `reset()` remain sound. No session is left stuck, but without the sender check above, a run can end unexpectedly.

### Suggestions
- `src/view.ts:95-109` (`vccSections`) Confirmed correct: the four-case guard (`!startsWith(header)` -> brief; `at < 0` -> headers only; else split) covers every shape `compile()` can emit, including after stripping `vcc_recall`. No split bug remains.
- `src/view.ts:79-86` (`progressKey`) Reading `extractFiles` directly avoids the 10-path cap in the rendered section. The key measures exactly what the README describes.

### Positive
- No hidden cap, budget, or automatic stop was added; the design constraint holds.

### Verdict
REQUEST CHANGES — the `done`/`unpair` sender guard is needed. The split fix survives review.

### Point 2 (contested finding, withdrawn)
Withdrawn. `DEFAULT_SUPERVISOR_PROMPT` is a model instruction (`"Call done only when..."`), not a tool contract. The `done` code (`src/index.ts:291-302`) correctly enforces only the pending-tool-call guard. Adding a heuristic check on `reason` (must contain path/quote) would create a new stopping rule, which violates the owner's constraint. Nothing to change in `prompts.ts`.