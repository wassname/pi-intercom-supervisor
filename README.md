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
pi install https://github.com/wassname/pi-intercom-supervisor   # needs npm:pi-intercom too

# terminal 1, the worker                # terminal 2, the supervisor
pi                                      pi
                                        /supervise make the results table
> do the work
```

You type one command, in one session. That session becomes the supervisor and its target becomes
the worker, so the role is decided at pairing time and neither session is one until then. The
worker needs no command, only the extension loaded, and it prints `supervised by <id>: <goal>` so
you can see which one was picked.

`/supervise` takes the only other session in this directory, so the whole line is the goal. With
more than one it refuses and lists them, since guessing is worse than asking. Run `/name worker`
in the one you want and then `/supervise worker make the table`, or use the id it printed, which
is the start of the `pi --session <id>` line in that terminal. `/supervise stop` ends it.

Working on this extension: `pi install /path/to/pi-supervise` points pi at the working tree, so
`/reload` picks up an edit with no commit and no push.

![worker and supervisor side by side: the steer lands in the worker's transcript while the supervisor waits for the next view](media/screenshot.png)

Both sessions load this extension and pick their role at runtime. The worker runs as ordinary pi.
When it stops, the supervisor gets a view of it and calls `steer` with one concrete next action, or
`done`. If it needs a human it replies in plain text instead of calling a tool, and that is what
reaches your phone. Supervising takes the writing tools off that session, `bash` and the edit tools,
and gives them back when supervision ends: it shares a working directory with the worker, and two
agents writing the same files is not supervision. It keeps `read` and `grep`, because checking a
claim against a file is the job. Policy comes from `<cwd>/.pi/SUPERVISOR.md`, then `<agent dir>/SUPERVISOR.md`,
then a built-in default, same precedence as the original, so an existing file keeps working. A
verdict here is a tool call, so nothing can fail to parse.

## How it works

The pi-intercom extension channel carries the data. It never enters a transcript and never starts a
turn, so each side triggers its own turn locally with `pi.sendUserMessage`, and the steer lands in
the worker's user and assistant trajectory where it belongs. Pairing is on `fromSessionId`, which
the broker stamps from its own registry, so a payload cannot forge it. The broker has no socket
authentication, so the trust level is any process running as you, and every session that loads this
extension sees every message. Do not load it in a session you would not trust with the transcript.

Each view carries only the turns since the last one, the way you read the new lines on a screen
rather than the scrollback. The supervisor is a real session that keeps every view it has read, so
re-sending the whole transcript would put a second copy of its own context in front of it, and the
cost would grow with every review. The goal line repeats every time, because that is the reminder
that stops it drifting onto whatever the worker is doing now. A worker compaction restarts the
count, and the view says so and carries the summary.

The view body is [pi-vcc](https://github.com/sting8k/pi-vcc)'s `compile()`, the same algorithmic
compactor (no LLM calls) you can run as your own. On top of it the view carries what a compactor
has no reason to track: tool calls with no result, child pi processes, tool errors, and whether
anything changed since the last review.

It also carries the worker's latest reasoning block, which pi-vcc drops and which you see on
screen when you watch a session. A worker going in circles says so there first, while it names
the approach it is about to retry, before any file or commit changes. Only the newest block, and
only its last 1200 characters, since a reasoning block ends on what it decided to do.

Resume and `/reload` both restore the goal and the round count out of the transcript, which is
where they belong. The paired session ID is not restored that way, because it addresses a live
process that may have exited while you were away. Each side asks the broker who is actually
connected and then says which it is: still supervising, or dropped because the other session is
gone. A resumed supervisor also has its writing tools taken off again, which the `/supervise`
handler alone would not do.

The supervisor looks at a working worker every half hour, and again whenever the worker stops.
Those two looks ask for different things. A stop is a decision point. A check in leans on `wait`,
because interrupting a working agent costs it its train of thought. The original also ran two
mechanical checks mid-turn, five tool errors in a row and five reads of one file with no edit.
Those are deleted: the supervisor sees the same errors in the view and judges them itself. Ported
and kept: the process tree check (`src/subagents.ts`, `ps` for child pi processes, so a settled
worker with a subagent still running is not called finished) and the SUPERVISOR.md precedence.

`src/prompts.ts` holds every word the supervisor reads, in the order it reads them. Only the nudge
and the view repeat per look; the policy, the verdict rules and the goal are sent once. The verdict
rules live in the tool descriptions, which the API sends at every model call, so a supervisor
compaction cannot lose them.

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

There are three verdicts, not two. `wait` was added after watching a real run: with only `steer`
and `done` on offer, a supervisor with nothing to say wrote "the harness demands a tool call ...
the least-bad option is a steer that adds something new", ran a command that printed nothing, and
reported the job was at "turn 47 of 80". The log said 75 of 80. Forcing a verdict at every look is
what bought that number, so now the usual answer at a check in is to say nothing.

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

The `done` guard sees child pi processes but not a detached job, a queue or a training run. Between
looks the supervisor is blind, so two minutes is the worst case for spotting a wrong path. Shorten
`WATCH_INTERVAL_MS` to pay more for a closer eye. Views are cut to 15 KB, oldest turns first,
because the broker drops anything over 16 KiB and never tells the extension. The last pair wins and
nothing authenticates it. The stagnation count lives in memory and restarts with the worker.

## Testing

```
npm test                      # 65 tests, free apart from a ps call
npx tsx scripts/e2e.ts        # two real pi processes and a real model, costs cents
PI_SUPERVISOR_DEBUG=1 pi ...  # trace the wire to stderr, since the channel is invisible
```
