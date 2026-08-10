# Research journal

## 2026-08-11 -- what wassname wants from a supervisor, and what he does not

This entry records the design preferences behind pi-intercom-supervisor, so a later reader does not
re-litigate settled choices. The extension pairs two pi coding-agent sessions: a worker that does
the work, and a supervisor that watches the worker and sends it instructions. Everything below
comes either from wassname's standing instructions file or from him in the session of 2026-08-10
and 2026-08-11, and each source is named in the sentence.

### Standing preferences, from his AGENTS.md

His instructions file states the general stance in the section headed IMPORTANT:

> this is fail fast research code, we want breaking changes to gain simplicity. no opt in! no
> defensive programing, no legacy, no backward compat, no fallback

and on complexity:

> Avoid adding losses, models, hyperparameters without removing equivalent complexity. Seek to
> simplify not add. If you add something, you must remove something else of equal complexity.

and on secondary objectives:

> Anything secondary should be a satisfiable CONSTRAINT (barrier penalty that shuts off when
> satisfied), not a competing objective.

His own supervisor policy file, at `~/.pi/profiles/autoresearch/SUPERVISOR.md`, rejects early
stopping and cites a measurement for it:

> The built-in prompt said to prefer stopping over "looping forever chasing perfection". That is
> wrong here. Measured result: at a fixed model, scaffolds that keep re-prompting scored 8.7% on
> MLE-bench against 0.8% for scaffolds that let the model stop (arXiv:2410.07095). Premature
> stopping is the failure mode we are trying to prevent.

### Preferences stated in this session

On the purpose of the rebuild, correcting me after I had described the phone link as the goal:

> na it was to simplify which I think you have done

On stopping rules, after I added a cap of twenty steer rounds and after two external reviewers
recommended replacing that cap with a spend budget:

> no! bad
> I want no budget at all! I want long until human stops

On the length of a supervision run, when I described the worker view as the last twenty four turns:

> hmm it's for logn day long many day tasks so I'd rather make sure supervision doesn't stop after
> N turns?. and doens't VCC have a better summary than last 24 turns? and should it not be
> compaction + N turns

On specific features he approved dropping: the four escalating rephrase levels ("fire") and the
strict JSON verdict replaced by a tool call ("good"). On one he requires: detection of delegated
work still running ("need"). On one he wants kept: inference of the goal at startup ("it's good").
On one he doubts my reasoning: the stagnation counters, where he asked "you think supervisor
understand now and doesn't need it?".

On repository hygiene he rejected three things I had committed: a copy of one of his real pi
session transcripts used as a test fixture, a directory of my own run logs, and my working notes
directory. On reporting style he twice rejected a feature comparison table as too long to read and
asked for short plain English.

### My reading of these, labelled as mine

My read is that a single principle explains all of the session preferences: the supervisor exists
to stop a run ending early, so any mechanism that can itself end a run early is the opposite of the
feature. I hold this *probable*, around 0.85, because it predicts the cap rejection, the multi-day
framing, and the SUPERVISOR.md quotation independently, and because he rejected the cap even after
two external models argued for replacing it rather than removing it.

That reading also resolves an apparent conflict with his no-defensive-programming rule. The oracle
review argued that a resource bound is domain policy rather than defensive fallback, which I agree
with, so the cap was not wrong for being a guard. It was wrong for being a competing stopping
objective in a system whose one job is not to stop.

A second reading, held less firmly at about 0.6, is that his "compaction plus N turns" request is
not a request to port the VCC summarisation pipeline into this extension. Real pi sessions already
store the summary written by whichever compactor the worker runs, in an entry carrying a `summary`
field. Reading that field gives the view a summary of everything older than the recent turns, and
it gives VCC's summary automatically when VCC is the compactor. If that reading is wrong, the
alternative is a real dependency on a summarisation library, which his copy-paste-over-dependency
rule would count against.

I am least confident about the stagnation counters, maybe 0.5. I claimed the supervisor no longer
needs them because it remembers its own past instructions, but that memory lives in its transcript
and a compaction can remove it, which is exactly what happens on the multi-day runs he described.

The practical takeaway is that this extension should run until a human stops it, should summarise
rather than truncate, and should keep only the guards that prevent a false ending.
