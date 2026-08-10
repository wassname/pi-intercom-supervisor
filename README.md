# pi-supervise

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
pi -n supervisor -e /path/to/pi-supervise/src/index.ts   # plus @llblab/pi-telegram
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
pi-supervise, not only to the paired one. `wire.to` is a filter applied by the receiver. So a third
pi session with this extension loaded can read every view and every steer, and can send a `pair` to
any worker that is not paired yet. On one machine, one user, that is the same trust level as the
broker itself. Do not load this extension in a session you would not trust with the worker's
transcript.

`MAX_STEER_ROUNDS` (default 20, set `PI_SUPERVISE_MAX_ROUNDS`) stops an unattended loop. The count
is written to session entries, so a compaction or a reload cannot reset it. A non-integer value
throws at load, because `NaN` would make the cap silently never fire.

The supervisor policy comes from `<cwd>/.pi/SUPERVISOR.md`, then `<agent dir>/SUPERVISOR.md`, then a
built-in default. That is the same precedence as pi-supervisor, so an existing file keeps working.
One difference: a verdict here is a tool call, not JSON, and the pairing brief says so explicitly.

## Testing

```
npm test                      # tier 1 and the fork fixture, no pi, no model, free
npx tsx scripts/e2e.ts        # tier 3: two real pi processes and a real model, costs cents
PI_SUPERVISE_DEBUG=1 pi ...   # trace the wire to stderr, since the channel is invisible
```

Evidence from a real run is in [docs/uat/](docs/uat/).

## Known limits

- The supervisor session is long lived, so its context grows with every review. pi-supervisor
  rebuilt context from scratch each time to avoid this. We accept the growth because the supervisor
  then remembers its own failed steers for free. Revisit if one overnight run needs more than one
  supervisor compaction.
- The first pair request wins. A second one is ignored, because there is nothing to authenticate it
  against.
- Views are cut to 15 KB, under the channel's 16 KiB limit. The transcript is trimmed from the
  front first; if the header alone is still too big, the whole view is truncated. Without that cut
  the broker rejects the payload and the extension is never told, so the supervisor would go blind.
- Every capable session sees every message. See the routing note above.
