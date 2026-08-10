# pi-supervise: a supervisor session you can reach from your phone

One pi session (the worker) does the work. A second pi session (the supervisor) watches it and
steers it. pi-intercom carries the messages between them. A chat bridge attached to the supervisor
lets you join from your phone. The appendix says why this replaces `@monotykamary/pi-supervisor`.

- [ ] goal A: prove the two session loop is worth building, with no new code
  - [ ] name both sessions, pin `stableId` in intercom `config.json`, give the supervisor `-t read,grep,list,intercom`
  - [ ] SUPERVISOR.md as `--append-system-prompt`; worker AGENTS.md tells it to intercom the supervisor when it stops
  - failure modes: the worker forgets to send the ping, so a prompt fault looks like a broken design; steers are too vague to change behaviour
  - deliverable: a `pi --export` transcript of 5 steer rounds, showing for each round whether the worker changed course
- [ ] goal B: worker extension, ping on settle and convert a directive to a user message
  - [ ] on `agent_settled`, intercom the paired supervisor session ID
  - [ ] on a directive from that ID only, call `pi.sendUserMessage(text, {deliverAs: "followUp"})`
  - [ ] pair on session ID, never on name, because the broker allows duplicate names
  - failure modes: the ping fires while a subagent still runs, so the supervisor judges half finished work
  - deliverable: `src/index.ts` under 150 lines, plus a test that a directive from an unpaired ID is dropped
- [ ] goal C: the worker view that the supervisor reads
  - [ ] `scripts/pi-view.ts` reads the worker session jsonl and walks `parentId` from the leaf to get the live branch
  - [ ] print goal, status, files touched, non zero exit codes, last N turns
  - ~~publish the view over the intercom extension channel~~ - a command the supervisor calls is simpler, and a human can run it too
  - failure modes: a plain tail includes entries from a branch abandoned by a fork or rewind, so the supervisor reviews undone work
  - deliverable: `pi-view <session> --tail 40` output beside the raw jsonl, showing the branch walk drops the dead entries
- [ ] goal D: reach the loop from a phone
  - [ ] attach `@llblab/pi-telegram` to the supervisor session, one thread per instance
  - failure modes: the bridge attaches to the worker, so your messages bypass the supervisor and its read only limits
  - deliverable: a phone screenshot, and the worker transcript line that the phone message produced
- [ ] goal E: the loop stops on its own
  - [ ] count steer rounds in the extension, stop and notify at the cap, persist the count with `pi.appendEntry`
  - [ ] a kill word from the phone calls `ctx.abort()` and unpairs
  - failure modes: the count lives in memory, so a compaction or reload resets it and the loop runs all night
  - deliverable: a log from a deliberate runaway test that shows the cap firing, taken after a forced compaction

## UAT / Verification

- ` .claude/plans/20260810_pi-supervise.md ` this file, updated with results per goal.
- ` docs/uat/loop_transcript.html ` the goal A export. Read it and judge if the steers helped.
- ` docs/uat/pi-view_vs_raw.md ` view output beside raw jsonl, proving the branch walk.
- ` docs/uat/runaway_capped.log ` the cap stopping a loop after a compaction.
- ` docs/uat/phone.png ` the phone screenshot, with the worker transcript line it caused.
- A fresh eyes subagent reads all five and reports whether they show the loop working, before I claim it.

## Appendix (context, not approved)

Why not extend `@monotykamary/pi-supervisor`: it has no hook a third party can use to see a
verdict. `grep -rn "emit(" src/` finds one call, and it registers a Fabric provider, not verdicts.
Steer verdicts are recoverable only by polling state; `continue` and `done` are never recorded.

What the source says holds up:
- worker idle is broadcast to every peer as `presence_update` with status `idle`/`thinking`/`tool:X`
  (pi-intercom `index.ts:676`, `broker/broker.ts:839`)
- an inbound intercom message wakes an idle session, because `inboundTrigger` defaults to `always`
  (`config.ts:52`)
- session IDs are the addressing key the README calls trusted; names are not unique
- the extension channel elects one owner per namespace and rejects stale owner-only writes, so two
  supervisors cannot both drive one worker

Open choice: the supervisor is a long lived session, so its context grows with each review.
monotykamary rebuilt context from scratch each time to avoid this. We accept the growth in v1
because it gives the supervisor memory of its own failed steers for free. Revisit if an overnight
run needs more than one supervisor compaction.

Name collision: `pi-supervisor` also registers `/supervise`. Disable it in the autoresearch profile.
