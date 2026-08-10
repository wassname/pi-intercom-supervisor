# pi-supervise: pi-supervisor rebuilt on pi-intercom

## Context

`@monotykamary/pi-supervisor` runs the supervisor as a hidden in-memory session. You cannot see it,
talk to it, or reach it from your phone. Your gist replaces that hidden session with a second real
pi session, and uses pi-intercom as the wire between the two. That makes the phone link nearly
free, because `@llblab/pi-telegram` already bridges one pi session, and you point it at the
supervisor. Repo: ` /media/wassname/SGIronWolf/projects5/2026/pi-supervise `, package
`@wassname2/pi-supervise`, one extension file loaded in both sessions.

- [x] goal A: a steer from the supervisor lands in the worker as a real user message
  - [x] `/supervise <worker> [goal]` in the supervisor session pairs on session ID from `intercom list`
  - [x] worker accepts a directive from the paired ID only, then calls `pi.sendUserMessage("[supervisor] ...")`
  - [x] pair on session ID, never on name, because the broker allows duplicate names and has no socket auth
  - failure modes: the steer arrives as a custom `intercom_message`, so it never joins the user and assistant trajectory
  - deliverable: DONE, ` docs/uat/steer_is_user_message.md `, two real pi processes, entry shows `"role": "user"`
- [x] goal B: the worker view the supervisor judges from
  - [x] on `agent_settled`, build the view from `ctx.sessionManager.getBranch()`, then send it to the supervisor
  - [x] view holds goal, status, files touched, non zero exit codes, last N turns; capped under 16 KiB
  - ~~a `pi-view` command that walks `parentId` in the session jsonl~~ - my error, `getBranch()` already returns the live branch
  - failure modes: the ping fires while a subagent still runs, so the supervisor judges half finished work
  - deliverable: DONE, `npx tsx scripts/show-branch.ts` on a real forked session: 400 entries, 377 on branch, 23 abandoned
- [ ] goal C: the supervisor decides, and the loop stops on its own
  - [x] tools `worker_view`, `steer`, `done`; policy from your existing SUPERVISOR.md, override path verified
  - [x] count steer rounds, persist with `pi.appendEntry`, and a reload test proves the cap is not refilled
  - [ ] a real overnight run, to see whether the supervisor's judgement is any good
  - failure modes: the count lives in memory, resets on reload, and the loop runs all night
  - deliverable: PARTIAL, unit and reload tests pass; no real long run yet, so the judgement is unproven
- [ ] goal D: the phone, needs you
  - [ ] attach `@llblab/pi-telegram` to the supervisor session and confirm `proactivePush` sends its replies
  - [x] escalation needs no tool: the supervisor replies in plain text, and your reply returns as a normal turn
  - failure modes: the bridge attaches to the worker, so your messages skip the supervisor and its read only limits
  - deliverable: BLOCKED on your phone and bot; everything else is built

## UAT / Verification

- ` docs/uat/steer_is_user_message.md ` the goal A jsonl entry, with the `intercom list` pairing beside it.
- ` docs/uat/view_after_fork.md ` the goal B view, proving no entries from the abandoned branch.
- ` docs/uat/runaway_capped.log ` the cap firing after a compaction.
- ` docs/uat/phone.png ` plus the worker line it caused.
- A fresh eyes subagent reads all four and says whether they show the loop working, before I claim it.

## How each tier is tested

- tier 1, no pi and no model: a fake `ExtensionAPI` object, copied from `intercom.integration.test.ts:141-212`.
  It records `sendMessage` calls, so a test asserts the exact `deliverAs` and `triggerTurn` used.
  Covers the view builder, the cap counter, and rejecting a directive from an unpaired session ID.
- tier 2, real broker and no model: spawn the broker into a temp HOME and join with raw socket peers,
  copied from `intercom.integration.test.ts:24-67` and `:214`. Covers pairing on session ID and the
  forged sender case, on the real wire.
- tier 3, two real pi processes: `pi --mode rpc` for worker and supervisor, both with `-e ./src/index.ts`
  and pi-intercom, isolated with `--session-dir`. Drive with `prompt`, read back with `get_messages`,
  then read the worker session jsonl. This produces the goal A and goal C artifacts.
  ~~`pi -p` for the worker~~ - `--print` exits after one prompt, so no steer can ever reach it.
  ~~a stub provider via `pi.registerProvider()`~~ - about 100 lines that can be wrong themselves, and it
  would hide the real runtime behaviour. A three turn run on a cheap model costs cents.

## Appendix (context, not approved)

The flaw you asked about. The supervisor is a long lived session, so its context grows with every
review. monotykamary rebuilt context from scratch each time to avoid this. We accept the growth in
version 1, because the supervisor then remembers its own failed steers, which lets us delete the
reframe tiers and the similarity detection. Revisit if one overnight run needs more than one
supervisor compaction.

Verified API facts this plan depends on:
- `getBranch(fromId?): SessionEntry[]` follows the current leaf path (`core/session-manager.d.ts:261`)
- `agent_settled` fires only when no retry, compaction, or queued continuation will run (`types.d.ts:546`)
- `sendUserMessage(content, {deliverAs})` accepts only `steer` or `followUp` (`types.d.ts:302`)
- pi-intercom wakes an idle session by default, `inboundTrigger: "always"` (`config.ts:52`)
- the pi-intercom README calls session IDs "the trusted addressing key"

Changed during the build: I planned to drop the intercom extension channel and use plain intercom
messages. I used the channel instead, because the plain message path injects a custom
`intercom_message` and starts a turn on the receiver, which is the exact failure mode goal A
guards against. The channel carries data without touching a transcript, so each side triggers its
own turn locally and the steer stays a real user message. The gist was right and I was wrong.
