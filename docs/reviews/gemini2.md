## Code Review: pi-intercom-supervisor logic and documentation parity

### Summary
The broker and pairing logic reliably close the orphaned-session holes identified in earlier reviews. The unpair propagation, 10-second acknowledgment timer, and takeover flows are solid and leave no dead ends. However, there is a discrepancy between the stated progress tracking and the implementation, and a formatting edge case in `vccSections` that defeats the byte-cutter.

### Critical (must fix)
- `src/view.ts:114`: `progressKey()` does not track commits. It extracts `modified` files, `created` files, and `distinct` errors, but ignores commits. Consequently, the view header, `README.md`, and `src/prompts.ts` overclaim by stating "no new file, commit or error". If a worker only makes commits during a turn, the stale counter will falsely increment, and the supervisor will be told no progress occurred. 

### Important (should fix)
- `src/view.ts:153`: In `vccSections()`, if `compile()` produces a brief transcript with no headers, but the brief transcript's first message literally begins with `[Session Goal]`, the code misclassifies the entire brief as `headers`. Because the channel-trimming loop below it only shrinks `brief`, a payload over 16 KiB falls through to the hard string slice, eating the newest turns instead of the oldest. 
- `src/prompts.ts:40`: The prompt instructs the supervisor to "Call done only when all of these hold: 1. the worker named the artifact file...", but the `done` tool itself (`src/index.ts:251`) only checks for unresolved subagent tool calls. It does not enforce file naming, quoting, or contradiction checks. This is an overclaim of what the code enforces.

### Verdict
REQUEST CHANGES