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

The view body is [pi-vcc](https://github.com/sting8k/pi-vcc)'s `compile()`, the same algorithmic
compactor the worker can run as its own. The two halves meet at the worker's last compaction: the
compactor's own summary covers everything up to it, and pi-vcc compiles every message after it.
Nothing sits in a gap between them, and nothing is sent twice. On top of that the view carries what
a compactor has no reason to track: tool calls with no result, tool errors, and whether anything
changed since the last review.

Pairing is on `fromSessionId`, which the broker stamps from its own registry
(`broker.ts:1247`), so a payload cannot forge it. The broker has no socket authentication, and its
own README calls session IDs "the trusted addressing key", so the trust level here is "any process
running as you", the same as pi itself.

The worker acknowledges a pair, and the last pair wins. A supervisor that gets no acknowledgment in
10 seconds unpairs and tells you, because the usual cause is a target that does not load this
extension. A worker taken over tells the supervisor that lost it. Before this, a worker whose
supervisor had died stayed bound to it forever and told nobody, while the new supervisor sat waiting
for a view that could never arrive.

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

Neither guard is as strong as it sounds, and an external review was right to say so. The goal guard
stops an ungrounded instruction, not an ungrounded goal: the supervisor can satisfy it by calling
`set_goal` with something vague. So `set_goal` sends the goal to the worker, where it heads every
later view, and tells the supervisor to quote it to you, which is the only real check on it. The
`done` guard proves that no tracked tool call is missing its result. It cannot see a detached
process, so it is not proof that no work is running.

Against a supervisor that loops, the view carries two mechanical signals, and neither of them stops
anything. It reports how many reviews in a row produced no new file, no new commit and no new error.
And an instruction that reuses the vocabulary of a recent one comes back named, so the supervisor
has to say what changed before repeating it. Word overlap catches a rewording, about 0.44 on a real
pair against under 0.2 for two different instructions. It scores 0 on a true paraphrase, so treat it
as a floor on repetition rather than a bound.

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
- The last pair wins, and nothing authenticates it. Any session that loads this extension can take
  a worker over. Same trust boundary as the broker: one machine, one user.
- Views are cut to 15 KB, under the channel's 16 KiB limit. The oldest turns go first, so the newest
  survive; if the header alone is still too big, the view is cut and says so. Without that cut the
  broker rejects the payload and the extension is never told, so the supervisor would go blind.
- Every capable session sees every message. See the routing note above.
- The stagnation count lives in memory. Restart the worker and it starts at zero again.
