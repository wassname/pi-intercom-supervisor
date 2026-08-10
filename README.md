# pi-intercom-supervisor

A supervisor pi session watches a worker pi session and steers it, over pi-intercom.

This is [monotykamary/pi-supervisor](https://github.com/monotykamary/pi-supervisor) with the hidden
in-memory supervisor replaced by a second real pi session. That one change is the point: you can
see the supervisor, talk to it, and bridge it to your phone with an ordinary chat extension.

## Use

Two terminals, both with `pi-intercom` and this extension loaded.

```
# terminal 1, the worker                # terminal 2, the supervisor
pi -n worker                            pi -n supervisor
                                        /supervise worker make the results table
> do the work
```

The worker runs as ordinary pi. When it stops, the supervisor gets a view of it and decides:
`steer` sends one concrete next action, `done` ends supervision. If the supervisor needs a human,
it replies in plain text instead of calling a tool.

For the phone, attach a chat bridge to the supervisor session, not the worker:

```
pi -n supervisor -e /path/to/pi-intercom-supervisor/src/index.ts   # plus @llblab/pi-telegram
```

Then you are talking to the supervisor, which is read only if you launch it with `-t read,grep,list`.

## How it works

```
worker                                   supervisor
  agent_settled
    -> buildView(getBranch())
    -> channel.publish({t:"view"})  --->  onEvent
                                          -> sendUserMessage(view)  [own turn]
                                          -> LLM calls steer
  onEvent                          <---   channel.publish({t:"directive"})
    -> sendUserMessage("[supervisor] ...")  [own turn]
```

The pi-intercom extension channel carries the data. It never enters a transcript and never starts a
turn, so each side triggers its own turn locally with `pi.sendUserMessage`. That keeps the steer in
the worker's user and assistant trajectory, where it belongs.

Pairing is on `fromSessionId`, which the broker stamps from its own registry
(`broker.ts:1247`), so a payload cannot forge it. The broker has no socket authentication, and its
own README calls session IDs "the trusted addressing key", so the trust level here is "any process
running as you", the same as pi itself.

Messages go out with `audience: "capable"`, which the broker routes to every session that loads
this extension, not only to the paired one. `wire.to` is a filter applied by the receiver. So a third
pi session with this extension loaded can read every view and every steer, and can send a `pair` to
any worker that is not paired yet. On one machine, one user, that is the same trust level as the
broker itself. Do not load this extension in a session you would not trust with the worker's
transcript.

There is no round limit and no budget, deliberately. Supervision runs until you type
`/supervise stop`. Ending a run early is the failure this exists to prevent: at a fixed model,
scaffolds that keep re-prompting scored 8.7% on MLE-bench against 0.8% for scaffolds that let the
model stop (arXiv:2410.07095). A cap would be a competing stopping objective.

Two guards remain, and both prevent a false ending rather than causing one. `steer` refuses while
no goal is set, so the supervisor asks you or calls `set_goal` instead of inventing work. `done`
refuses while the worker has a tool call with no result, so a running subagent cannot be declared
finished. The goal, the pairing, the instruction count and the last few instructions are written to
session entries, so a compaction or a reload keeps them.

The supervisor policy comes from `<cwd>/.pi/SUPERVISOR.md`, then `<agent dir>/SUPERVISOR.md`, then a
built-in default. That is the same precedence as pi-supervisor, so an existing file keeps working.
One difference: a verdict here is a tool call, not JSON, and the pairing brief says so explicitly.

## Testing

```
npm test                      # tier 1 and the fork fixture, no pi, no model, free
npx tsx scripts/e2e.ts        # tier 3: two real pi processes and a real model, costs cents
PI_SUPERVISOR_DEBUG=1 pi ...   # trace the wire to stderr, since the channel is invisible
```

`scripts/e2e.ts` writes its log to `docs/uat/`, which is not committed.

## Known limits

- The supervisor session is long lived, so its context grows with every review. Measured at about
  3.5 KB per review on a trivial worker, and a real worker view can reach 15 KB. Its own compaction
  handles the tail, and the last few instructions are persisted outside the transcript so a
  compaction cannot erase them. Not yet solved: the review prompt still carries the whole view.
- The outstanding-work check only sees tool calls inside the session. A detached process, a queued
  job or a training run that outlives the turn still reads as finished.
- The supervisor only looks when the worker stops. A worker an hour down the wrong path is not
  caught until it settles. pi-supervisor also watched mid-turn; this does not.
- The first pair request wins. A second one is ignored, because there is nothing to authenticate it
  against.
- Views are cut to 15 KB, under the channel's 16 KiB limit. The transcript is trimmed from the
  front first; if the header alone is still too big, the whole view is truncated. Without that cut
  the broker rejects the payload and the extension is never told, so the supervisor would go blind.
- Every capable session sees every message. See the routing note above.
