# pi-intercom-supervisor

Original ask:
> https://github.com/monotykamary/pi-supervisor but with pi-intercom and linked to matrix or telegram
> - wassname

[monotykamary/pi-supervisor](https://github.com/monotykamary/pi-supervisor) runs the supervisor as a
hidden in-memory session. This runs it as a second real pi session and uses
[pi-intercom](https://github.com/tintinweb/pi-intercom) as the wire between the two. You can see the
supervisor, talk to it, and bridge it to your phone with any chat extension, because it is just a pi
session. That swap deleted the context pipeline, the four reframe tiers, the JSON verdict parser,
the widget and the plugin API: 5201 lines of `src` down to 788.

```
# terminal 1, the worker                # terminal 2, the supervisor
pi -n worker                            pi -n supervisor
                                        /supervise worker make the results table
> do the work
```

Both sessions load this extension and pick their role at runtime. The worker runs as ordinary pi.
When it stops, the supervisor gets a view of it and calls `steer` with one concrete next action, or
`done`. If it needs a human it replies in plain text instead of calling a tool, and that is what
reaches your phone. Policy comes from `<cwd>/.pi/SUPERVISOR.md`, then `<agent dir>/SUPERVISOR.md`,
then a built-in default, same precedence as the original, so an existing file keeps working. A
verdict here is a tool call, so nothing can fail to parse.

## How it works

The pi-intercom extension channel carries the data. It never enters a transcript and never starts a
turn, so each side triggers its own turn locally with `pi.sendUserMessage`, and the steer lands in
the worker's user and assistant trajectory where it belongs. Pairing is on `fromSessionId`, which
the broker stamps from its own registry, so a payload cannot forge it. The broker has no socket
authentication, so the trust level is any process running as you, and every session that loads this
extension sees every message. Do not load it in a session you would not trust with the transcript.

The view body is [pi-vcc](https://github.com/sting8k/pi-vcc)'s `compile()`, the same algorithmic
compactor (no LLM calls) you can run as your own. The two halves meet at the worker's last
compaction: the compactor's summary covers everything before it, pi-vcc compiles every message
after. On top of that the view carries what a compactor has no reason to track: tool calls with no
result, child pi processes, tool errors, and whether anything changed since the last review.

Three of the original's behaviours are ported rather than reinvented, all MIT: mid-run signals
(`src/signals.ts`, five tool errors in a row or five reads of one file with no edit, checked on
`turn_end` so a worker an hour down the wrong path is caught before it stops), the process tree
check (`src/subagents.ts`, `ps` for child pi processes, so a settled worker with a subagent still
running is not called finished), and the SUPERVISOR.md precedence.

The process check is a snapshot where the original polls for two minutes. pi awaits the settle
handler, so polling there holds the worker's own settle for the whole poll. The loop already does
the waiting: the supervisor sees the process listed, `done` is refused, and it steers the worker to
wait instead. That puts the waiting in the transcript where you can read it.

## Decisions

No round cap, no budget, no automatic stop. Supervision runs until you type `/supervise stop` or
the supervisor calls `done` on evidence. Ending early is the failure this exists to prevent: at a
fixed model, scaffolds that keep re-prompting scored 8.7% on MLE-bench against 0.8% for scaffolds
that let the model stop ([arXiv:2410.07095](https://arxiv.org/abs/2410.07095)). A cap would be a
competing stopping objective.

Two guards remain and both prevent a false ending. `steer` is refused while no goal is set, so the
supervisor asks you or calls `set_goal`, which sends the goal to the worker and heads every later
view. `done` is refused while a tool call has no result or a child pi process is running. Neither is
as strong as it sounds. The first stops an ungrounded instruction, not an ungrounded goal, since the
supervisor can call `set_goal` with something vague; quoting it to you is the only real check. The
second proves no tracked work is missing, not that nothing is running.

Against a supervisor that circles, the view reports how many reviews in a row produced no new file,
commit or error, and an instruction that reuses a recent one's vocabulary comes back named. Neither
stops anything. Word overlap runs about 0.44 on a rewording against under 0.2 on two different
instructions, and 0 on a paraphrase sharing no words, so it is a floor on repetition, not a bound.

## Limits

The `done` guard sees child pi processes but not a detached job, a queue or a training run. Mid-run
watching only fires on the two signals above, so quieter wrong paths still wait for the worker to
stop. Views are cut to 15 KB, oldest turns first, because the broker drops anything over 16 KiB and
never tells the extension. The last pair wins and nothing authenticates it. The stagnation count
lives in memory and restarts at zero with the worker.

## Testing

```
npm test                      # 54 tests, free apart from a ps call
npx tsx scripts/e2e.ts        # two real pi processes and a real model, costs cents
PI_SUPERVISOR_DEBUG=1 pi ...  # trace the wire to stderr, since the channel is invisible
```
