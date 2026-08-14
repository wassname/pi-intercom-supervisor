/**
 * intercom-supervisor: a supervisor pi session watches a worker pi session and steers it.
 *
 * Load this extension in both sessions. Type /supervise <worker> in the supervisor.
 *
 * Wire: the pi-intercom extension channel carries data without starting a turn, so each side
 * triggers its own turn locally with pi.sendUserMessage. The broker stamps fromSessionId from its
 * own registry, so pairing on that ID cannot be forged by a payload.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Type } from "typebox";
import type {
  IntercomExtensionChannel,
  IntercomExtensionEvent,
} from "pi-intercom/extension-api.ts";

/**
 * Copied from pi-intercom/extension-api.ts, because a git install gets no node_modules/pi-intercom
 * and a value import from it fails at load. The types above are erased, so they cost nothing.
 * src/index.test.ts imports the real constant, so a rename in pi-intercom fails a test here.
 */
const INTERCOM_EXTENSION_REGISTER_EVENT = "intercom:extension-register";
import { age, buildView, progressKey, sinceLastTurn, turnsSince } from "./view.ts";
import { childPiProcesses } from "./subagents.ts";
import {
  EMPTY_STATE,
  NAMESPACE,
  OVERLAP_WARN,
  STATE_ENTRY,
  STEER_MEMORY,
  isWire,
  overlap,
  restoreState,
  type SuperviseState,
  type Wire,
} from "./protocol.ts";
import {
  BRIEF,
  DONE_BLOCKED,
  GOAL_CHANGED,
  NO_GOAL,
  REANCHOR,
  REVIEW_NUDGE,
  TOOL_DONE,
  TOOL_STEER,
  TOOL_LET_IT_RUN,
  LET_IT_RUN_ACK,
  LET_IT_RUN_AGAIN,
  STEER_ACK,
  VIEW_PRUNED,
  isViewText,
  loadSupervisorPrompt,
} from "./prompts.ts";

/**
 * The worker's model and context use, for the view header, from its own broker presence record.
 *
 * contextPct is missing right after a compaction and on a session with no model selected, so it is
 * left out rather than printed as 0, which would read as an empty context.
 */
function workerModel(info: { model: string; contextPct?: number }): string {
  return info.contextPct === undefined ? info.model : `${info.model}, ${info.contextPct}% of its context used`;
}

/**
 * A goal that is one word containing a slash or a dot is a path, and the file is the goal.
 *
 * A goal worth grading against runs to paragraphs of acceptance evidence, and retyping it into a
 * prompt each run is how the copy you steer by drifts from the copy you grade by. A missing file
 * throws, with the path in the message.
 */
function readGoal(cwd: string, goal: string): string {
  if (!/^\S+$/.test(goal) || !/[/.]/.test(goal)) return goal;
  return readFileSync(resolve(cwd, goal), "utf8").trim();
}

/** A goal on one line, for a notice or a picker title. The goal itself is never cut. */
function firstLine(goal: string, width = 60): string {
  const line = goal.trim().split("\n")[0].trim();
  return line.length > width ? `${line.slice(0, width)}...` : line;
}

/**
 * The footer line, kept to two words plus a glyph.
 *
 * pi-powerline-footer appends extension statuses to the end of its own line, so this costs footer
 * width for the whole session. The oracle's status can afford to be long because it shows only
 * while a run is going. The paired session id is left out: it helps only with three sessions open,
 * and you already know which terminal you are looking at.
 */
const STATUS_ID = "intercom-supervisor";
const EYE = "\u{1F441}";

/** How long the supervisor waits for the worker to acknowledge a pair before giving up on it. */
const PAIR_ACK_TIMEOUT_MS = 10_000;

/**
 * How long /supervise waits for the roll call. One round trip over a local unix socket, so this is
 * mostly slack for a session busy in the middle of a turn.
 */
const ROLL_CALL_MS = 500;

/**
 * Set in every session pi-subagents starts (pi-args.ts:622, unconditional), so a child run can
 * recognise itself and stay out of the roll call.
 */
const SUBAGENT_ENV = "PI_SUBAGENT_CHILD";

/**
 * How often the supervisor looks at a worker that is still working. It also looks when the worker
 * stops, whatever this is set to, so a short turn is never missed.
 *
 * One supervisor turn per interval per busy worker, so this is the token bill of watching. Half an
 * hour is the wandering-past rate a human keeps; shorten it if you want a closer eye.
 */
const WATCH_INTERVAL_MS = 1_800_000;

/** How often the timer checks whether a look is due. Sets how late a look can be, nothing else. */
const WATCH_POLL_MS = 30_000;

/** How many identical timer looks are skipped before the supervisor is shown one anyway. */
const LOOKS_SKIPPED_MAX = 3;

/**
 * A view without the one line that changes on its own.
 *
 * The status line carries seconds into the turn, so two views of a worker that has done nothing are
 * never byte-identical. Everything else in a view comes from the worker's branch.
 */
const bodyOf = (view: string) => view.split("\n").filter((line) => !line.startsWith("status: ")).join("\n");

/**
 * Tools taken away from a supervising session, and given back when supervision ends.
 *
 * The supervisor shares a working directory with the worker, so a supervisor that can write is a
 * second agent editing the same files at the same time. It keeps read, grep and the rest, because
 * checking a claim against a file is its job. If it wants a command run, it steers the worker.
 *
 * A deny list, not an allow list: a read tool named something unexpected stays available rather
 * than silently disappearing. The kept list is printed, so a writer this misses is visible.
 */
const WRITER_TOOLS = new Set([
  "bash", "edit", "write", "multi_edit", "multiedit", "apply_patch", "notebook_edit",
  "edit_file", "write_file", "quick_edit", "target_edit",
]);

/**
 * The tools only a supervisor should have. Hidden in every session that is not supervising.
 *
 * Both sessions load this extension and registration happens at load, so without this a plain
 * worker is offered worker_view, steer, let_it_run and done. Observed 2026-08-12: a worker given an
 * ordinary coding task spent twelve turns reasoning "these are supervisor tools ... so I might be
 * the supervisor for a worker session", called worker_view, and read "the worker has not stopped
 * since pairing" as proof of a pairing it never had.
 */
const SUPERVISOR_TOOLS = ["worker_view", "set_goal", "steer", "let_it_run", "done"];

export default function (pi: any) {
  let channel: IntercomExtensionChannel | undefined;
  let state: SuperviseState = { ...EMPTY_STATE };
  let latestView = "";
  /** Supervisor side: whether the worker was stopped in that view, which changes what let_it_run costs. */
  let workerStopped = false;
  let ctx: any;
  let ownId = "";
  /** Worker side: the last progressKey, and how many reviews in a row have matched it. */
  let lastProgress = "";
  let staleReviews = 0;
  /** Worker side: how many turns the supervisor has already been sent, so views carry only the new ones. */
  let sentTurns = 0;
  /** Worker side: the routine look, and when the last view of any kind went out. */
  let watchTimer: ReturnType<typeof setInterval> | undefined;
  let lastLook = 0;
  /** Worker side: the last view sent, less its status line, and how many timer looks matched it. */
  let lastViewBody = "";
  let looksSkipped = 0;
  /** Supervisor side: cleared when the worker acknowledges the pair. */
  let pairTimer: ReturnType<typeof setTimeout> | undefined;
  /** Supervisor side: the writer tools this session had, so reset gives back exactly those. */
  let removedWriters: string[] = [];
  /** Supervisor side: who answered the roll call, collected only while /supervise is waiting. */
  let rollCall: Set<string> | undefined;

  /** PI_SUPERVISOR_DEBUG=1 traces the wire to stderr. The channel is invisible in transcripts. */
  const debug = (event: string, detail: unknown = {}) => {
    if (process.env.PI_SUPERVISOR_DEBUG) console.error(`[intercom-supervisor] ${event} ${JSON.stringify(detail)}`);
  };

  function save() {
    pi.appendEntry(STATE_ENTRY, state);
    showStatus();
  }

  /**
   * One footer line while a pairing is live, so both terminals say what they are.
   *
   * A pairing is otherwise invisible after the notice at the top scrolls away. wassname started a
   * supervisor, saw it sitting at the prompt, and could not tell that it had stopped supervising.
   * Mechanism borrowed from @diegopetrucci/pi-oracle, which puts its run in the same place.
   */
  function showStatus() {
    if (!ctx?.hasUI) return;
    if (state.role === "none") {
      ctx.ui.setStatus(STATUS_ID, undefined);
      return;
    }
    const text = state.role === "supervisor" ? `watching ${state.steerRounds}` : "watched";
    ctx.ui.setStatus(STATUS_ID, ctx.ui.theme.fg("accent", `${EYE} `) + ctx.ui.theme.fg("dim", text));
  }

  function send(message: Wire) {
    if (!channel) throw new Error("intercom-supervisor: intercom channel is not ready");
    channel.publish(message, { audience: "capable" });
  }

  /**
   * Put words in the supervisor's own context without starting a turn.
   *
   * The brief, the reanchor and a goal change all say "a view follows", and the view is the thing
   * to judge. A user message always starts a turn (pi types.d.ts:754), so the supervisor answered
   * these with a verdict before any view existed: twice on 2026-08-13, and 98 times an hour before
   * that. No wording stops it, because the turn should not be there at all. A custom message with
   * triggerTurn false joins the context and waits for the view to wake it (agent-session.d.ts:343).
   * display true keeps it on screen, where a user message used to be. - CLAUDE
   */
  function tellSupervisor(text: string) {
    pi.sendMessage({ customType: "supervisor_brief", content: text, display: true }, { triggerTurn: false });
  }

  /**
   * Ask every session whether it can be supervised, and collect the ones that say yes.
   *
   * The broker roster is not the candidate list. It carries child runs from pi-subagents, sessions
   * that do not load this extension, sessions already paired, and registrations whose process has
   * gone. Observed 2026-08-13: five of them at once in one directory, and /supervise refused to
   * pick between them because every filter here worked by guessing from the outside.
   *
   * Each session knows its own answer, so it gives it. A child run reads SUBAGENT_ENV in its own
   * environment; a paired one knows it is paired; a dead one cannot answer at all. No process tree,
   * no naming convention.
   */
  async function askWhoIsFree(): Promise<Set<string>> {
    const found = new Set<string>();
    rollCall = found;
    send({ t: "who", to: "*" });
    await new Promise((resolve) => setTimeout(resolve, ROLL_CALL_MS));
    rollCall = undefined;
    debug("roll call", { answered: [...found].map((id) => id.slice(0, 8)) });
    return found;
  }

  /**
   * Our own record in the broker registry. The broker records pid at registration, so we match on
   * it. Read fresh every time: presence keeps model and context use up to date in here.
   */
  async function ownSession(): Promise<any> {
    const sessions = await channel!.listSessions();
    const mine = sessions.find((s: any) => s.pid === process.pid);
    if (!mine) throw new Error("intercom-supervisor: this session is not registered with the intercom broker");
    ownId = mine.id;
    return mine;
  }

  /** Our own intercom session ID, which never changes, so the first answer is kept. */
  async function resolveOwnId(): Promise<string> {
    return ownId || (await ownSession()).id;
  }

  /**
   * Show or hide the supervisor tools. setActiveTools ignores names it does not know, so the list
   * is read back: a hide that leaves them visible is the confusion this exists to stop.
   */
  function showSupervisorTools(on: boolean) {
    const rest = pi.getActiveTools().filter((t: string) => !SUPERVISOR_TOOLS.includes(t));
    pi.setActiveTools(on ? [...rest, ...SUPERVISOR_TOOLS] : rest);
    const now = pi.getActiveTools().filter((t: string) => SUPERVISOR_TOOLS.includes(t));
    if (on ? now.length !== SUPERVISOR_TOOLS.length : now.length > 0) {
      throw new Error(
        `intercom-supervisor: setActiveTools did not ${on ? "add" : "remove"} the supervisor tools, left ${now.join(", ") || "none"}`,
      );
    }
  }

  /**
   * Take the writing tools off this session. Supervising is a read-only job in a directory
   * another agent is writing to. reset() hands them back.
   *
   * These live on the pi API, not on the command context. Reaching for the context is what let a
   * supervisor make 36 bash calls in the session that ran /supervise: the old code wrote
   * context.getActiveTools?.() ?? [], got undefined, kept an empty list, and skipped in silence.
   * Unguarded now, and the list is read back, so a strip that does nothing throws instead.
   */
  function stripWriters(): string[] {
    const before: string[] = pi.getActiveTools();
    const kept = before.filter((t: string) => !WRITER_TOOLS.has(t.toLowerCase()));
    // Remember the names removed, not the whole list. Other extensions add and remove their own
    // tools while supervision runs (pi-context-prune adds context_prune, pi-telegram suspends its
    // own), so restoring a snapshot taken hours ago would silently undo their decisions.
    removedWriters = before.filter((t: string) => WRITER_TOOLS.has(t.toLowerCase()));
    pi.setActiveTools(kept);
    const still = pi.getActiveTools().filter((t: string) => WRITER_TOOLS.has(t.toLowerCase()));
    if (still.length) throw new Error(`intercom-supervisor: setActiveTools did not remove ${still.join(", ")}`);
    return kept;
  }

  /**
   * What a restored pairing means on the wire, checked once the channel exists.
   *
   * restoreState reads the transcript, which is right for the goal and the round count and wrong
   * for pairedId: that addresses a live process, and after a resume or a /reload the process on
   * the other end may be gone. A resumed session then sits idle claiming a pairing, says nothing
   * on screen, and refuses /supervise until you work out it needs /supervise stop.
   *
   * The broker's registry is the truth about who exists now, so ask it. Either way this prints,
   * because "supervising, waiting" and "the other session is gone" look identical otherwise.
   */
  async function rejoinOrDrop() {
    if (!state.role || !state.pairedId) return;
    const live = await channel!.listSessions();
    if (!live.some((s: any) => s.id === state.pairedId)) {
      reset(`intercom-supervisor: ${state.pairedId.slice(0, 8)} is gone, so the pairing is dropped. Run /supervise to start again.`);
      return;
    }
    if (state.role !== "supervisor") {
      ctx?.ui?.notify?.(`intercom-supervisor: still supervised by ${state.pairedId.slice(0, 8)}`, "info");
      return;
    }
    // The strip lives in the /supervise handler and savedTools is memory, so a resumed supervisor
    // has bash and the edit tools back in a directory the worker is writing to.
    stripWriters();
    // Say the goal and the answer shape again. A /reload is how a changed prompt reaches a running
    // session, and the brief goes out only at pairing, so without this a wording fix needs a fresh
    // pairing and loses the supervisor's memory of its own steers.
    tellSupervisor(REANCHOR(state.goal, state.steerRounds));
    // Ask for a view rather than wait for one. A supervisor that came back from a crash, a credit
    // failure or a /reload holds a stale picture, and answering from a stale picture is how it
    // invents a fact. Only the worker makes views, so it has to ask, and nobody should have to
    // know that: restarting the session is the whole recovery.
    send({ t: "look", to: state.pairedId });
    ctx?.ui?.notify?.(`intercom-supervisor: still supervising ${state.pairedId.slice(0, 8)}, asked it for a view`, "info");
  }

  /** Everything that ends a pairing goes through here, so no stale view or timer survives it. */
  function reset(note: string) {
    clearTimeout(pairTimer);
    pairTimer = undefined;
    clearInterval(watchTimer);
    watchTimer = undefined;
    if (removedWriters.length) {
      pi.setActiveTools([...pi.getActiveTools(), ...removedWriters]); // give back what we took
      removedWriters = [];
    }
    showSupervisorTools(false);
    state = { ...EMPTY_STATE };
    latestView = "";
    lastProgress = "";
    staleReviews = 0;
    sentTurns = 0;
    save();
    ctx?.ui?.notify?.(note, "info");
  }

  // ---- inbound, one branch per role ------------------------------------------------------

  async function onWire(from: string, wire: Wire) {
    const me = await resolveOwnId();
    debug("wire in", { t: wire.t, from: from.slice(0, 8), forUs: wire.to === me, role: state.role });

    // Answered before the addressed-to-us check below, because a roll call goes to everyone.
    if (wire.t === "who") {
      if (from !== me && state.role === "none" && !process.env[SUBAGENT_ENV]) send({ t: "here", to: from });
      return;
    }
    if (wire.to !== me) return;

    // Collected only while /supervise is waiting, so a late answer lands nowhere and is dropped.
    if (wire.t === "here") {
      rollCall?.add(from);
      return;
    }

    if (wire.t === "pair") {
      // Last pair wins. First-wins left a worker bound forever to a supervisor that had died, and
      // told nobody. The loser is told, so neither side waits on a pairing it does not have.
      if (state.pairedId && state.pairedId !== from) send({ t: "unpair", to: state.pairedId });
      // We are a worker now, so any pair we sent as a supervisor is void. Leaving that timer armed
      // would kill this healthy pairing ten seconds later, blaming a session no longer involved.
      clearTimeout(pairTimer);
      pairTimer = undefined;
      state = { ...EMPTY_STATE, role: "worker", pairedId: from, goal: wire.goal };
      latestView = "";
      lastProgress = "";
      staleReviews = 0;
      save();
      send({ t: "paired", to: from });
      ctx?.ui?.notify?.(`supervised by ${from.slice(0, 8)}: ${firstLine(wire.goal)}`, "info");
      // A first view goes with the acknowledgement. Without it the supervisor's opening turn has
      // nothing to read, and it answers anyway: on 2026-08-13 it called let_it_run 98 times over
      // "waiting for the first view". A worker paired while idle never settles, so waiting for
      // agent_settled can mean waiting for ever.
      await publishView(ctx, "sent at pairing");
      return;
    }

    if (from !== state.pairedId) return; // ignore anything from a session we are not paired with

    if (wire.t === "paired" && state.role === "supervisor") {
      clearTimeout(pairTimer);
      pairTimer = undefined;
      return;
    }

    if (wire.t === "goal" && state.role === "worker") {
      // The supervisor inferred a goal. The worker holds the copy the view header is built from,
      // so without this the header says "not set" for the rest of the run.
      state = { ...state, goal: wire.goal };
      save();
      ctx?.ui?.notify?.(`goal set by the supervisor: ${wire.goal}`, "info");
      return;
    }

    if (wire.t === "look" && state.role === "worker") {
      // Only the worker can make a view, so a supervisor that lost its place has to ask. It loses
      // its place whenever its own turn ends without one: a crash, a credit failure, a /reload.
      // Its answer to a stale context is to invent, so give it real data instead.
      // From turn 0, not the diff. A supervisor only asks after a crash or a /reload, when its own
      // copy is gone, and answering that with "0 new turns since your last look" leaves it inventing.
      await publishView(ctx, "sent because you asked for a view", 0);
      return;
    }

    if (wire.t === "directive" && state.role === "worker") {
      // Busy worker gets "steer": delivered after the current tool calls, before the next LLM call.
      // "followUp" would make it finish the whole task first, so a correction arrives too late to
      // correct anything. Idle worker takes no option, so the message starts a turn.
      pi.sendUserMessage(`[supervisor] ${wire.text}`, ctx?.isIdle() ? undefined : { deliverAs: "steer" });
      return;
    }

    if (wire.t === "view" && state.role === "supervisor") {
      latestView = wire.view;
      workerStopped = wire.stopped;
      // A new view is a new look, so it gets its own verdict. agent_start alone is not enough: a
      // followUp is consumed inside the running agent loop, so no second agent_start fires and the
      // count carries over. That aborted the second honest verdict of a busy night. - CLAUDE
      verdictsThisLook = 0;
      // followUp, not steer: let the supervisor finish the decision it is making, then look again.
      // With no option at all pi throws "Agent is already processing" and the view is lost, which
      // on a two minute look means the supervisor skips a whole look for no visible reason.
      pi.sendUserMessage(
        REVIEW_NUDGE(wire.view, state.steerRounds, wire.stopped),
        ctx?.isIdle() ? undefined : { deliverAs: "followUp" },
      );
      return;
    }

    if (wire.t === "done" || wire.t === "unpair") {
      reset(`supervision ended: ${wire.t === "done" ? wire.reason : "unpaired"}`);
    }
  }

  // ---- lifecycle -------------------------------------------------------------------------

  // The other reset. This one covers a turn the human starts by typing; the view branch above
  // covers a view, which is the usual way a look begins.
  pi.on("agent_start", () => {
    verdictsThisLook = 0;
  });

  /**
   * A finished look keeps its verdict and loses the raw material behind it.
   *
   * Every look brings a view of about 1.4k tokens and a block of thinking about as long, and neither
   * means anything once the verdict is written. Session 019ffa73, 16 hours and 75 looks: the context
   * ran 37.9k -> 234.7k with no compaction, and was 56% view bodies and 32% old thinking by
   * character count. What the supervisor actually needs is the 7% that is its own verdicts, e.g.
   * "job 26 Evidence-b partially landed: post rho 0.726 > prompted 0.718 (was tied before rebuild),
   * probe d flipped +0.059". Those are its running notes on the worker, and better memory than the
   * turns it read to write them.
   *
   * Cache reads are $0.004/Mtok, so this was never about the bill. It is that a model judging one
   * view should not be reading 234k tokens to do it.
   *
   * Views are incremental, each covering what is new since the last, so the newest few stay whole
   * in case the current one reads against them. scripts/measure-prune.ts replays a real session.
   */
  const LOOKS_KEPT = 3;
  pi.on("context", (event: any) => {
    if (state.role !== "supervisor") return;
    const isView = (m: any) =>
      m.role === "user" && m.content?.some?.((c: any) => c.type === "text" && isViewText(c.text));

    // Everything before the oldest look we keep whole is history.
    const views = event.messages.flatMap((m: any, i: number) => (isView(m) ? [i] : []));
    if (views.length <= LOOKS_KEPT) return;
    const cut = views[views.length - LOOKS_KEPT];

    // New objects, never a mutation: event.messages is the live branch the session also reads from.
    return {
      messages: event.messages.flatMap((m: any, i: number) => {
        if (i >= cut) return [m];
        if (isView(m)) return [{ ...m, content: [{ type: "text", text: VIEW_PRUNED }] }];
        if (m.role !== "assistant") return [m];
        const kept = (m.content ?? []).filter((c: any) => c.type !== "thinking");
        // A message that was only thinking has nothing left to say, and holds no tool call to orphan.
        return kept.length ? [{ ...m, content: kept }] : [];
      }),
    };
  });

  pi.on("session_start", async (_event: unknown, context: any) => {
    ctx = context;
    state = restoreState(context.sessionManager.getEntries());
    // Before anything else, because a worker that can see steer and worker_view starts guessing
    // that it is a supervisor. rejoinOrDrop below may still drop the pairing and hide them again.
    showSupervisorTools(state.role === "supervisor");
    showStatus(); // a resumed pairing has no notice to read, so the footer is all you get
    pi.events.emit(INTERCOM_EXTENSION_REGISTER_EVENT, {
      namespace: NAMESPACE,
      ownerEligible: false,
      onReady: (value: IntercomExtensionChannel) => {
        channel = value;
        rejoinOrDrop().catch((err: Error) => debug("rejoin failed", { error: err.message }));
      },
      onEvent: (event: IntercomExtensionEvent) => {
        if (event.type === "message" && isWire(event.payload)) {
          // Not awaited by the caller, so a rejection here would be an unhandled rejection with no
          // notice. resolveOwnId throws during a startup race.
          onWire(event.fromSessionId, event.payload).catch((err: Error) => {
            debug("wire dropped", { error: err.message });
            ctx?.ui?.notify?.(`intercom-supervisor: dropped a message, ${err.message}`, "error");
          });
        }
      },
    });
  });

  /**
   * Publish what the worker looks like right now. Used at pairing, on a timer and when asked.
   * `since` is the turn the view starts at: the diff for a routine look, 0 when the supervisor
   * needs the whole picture again.
   */
  async function publishView(context: any, why: string, since = sentTurns, onlyIfChanged = false) {
    // Claimed before the await, not after. ps takes long enough that a second timer tick would
    // otherwise start its own look while this one is still waiting.
    lastLook = Date.now();
    const entries = context.sessionManager.getBranch() as any;
    // Checked here too. This view replaces the one done reads, so leaving it out would report
    // "child pi processes still running: none" and unblock done while a subagent is running.
    const subagents = await childPiProcesses();
    // Asked at pairing and on a rejoin, and the worker is often sitting at the prompt then. Saying
    // "working" there sends the supervisor a check-in nudge about a worker that is waiting on it.
    const idle = context.isIdle();
    // One clock for both ways of being stuck: at the prompt, and inside a command that never
    // returns. It goes in the status line because bodyOf strips that line, so a number that moves
    // on its own cannot defeat the unchanged-view skip below.
    const view = buildView({
      goal: state.goal,
      status: `${idle ? "stopped" : "working"}, ${why}, no new turn for ${age(sinceLastTurn(entries))}`,
      entries,
      since,
      subagents,
      model: workerModel(await ownSession()),
    });
    // A timer look at a worker that has done nothing since the last one wakes the supervisor to read
    // a view it has already read. Session 019ffa73: 13 of 92 verdicts were "check-in with no new
    // turns ... nothing to judge". The supervisor loses nothing by not being asked, because the view
    // is the same view. It is asked anyway after LOOKS_SKIPPED_MAX, since a worker that has not moved
    // for hours is itself worth seeing, and the elapsed seconds in the status line say so.
    if (onlyIfChanged) {
      if (bodyOf(view) === lastViewBody && looksSkipped < LOOKS_SKIPPED_MAX) {
        looksSkipped += 1;
        debug("look skipped, nothing new since the last view", { looksSkipped });
        return;
      }
      looksSkipped = 0;
    }
    lastViewBody = bodyOf(view);

    sentTurns = turnsSince(entries);
    send({ t: "view", to: state.pairedId, view, stopped: idle });
    debug("published view", { why, to: state.pairedId, sentTurns, idle });
  }

  /**
   * The timer look. A human supervising does not read every token; they wander past every few
   * minutes and interrupt if the work has gone somewhere wrong. This is that, so the supervisor
   * keeps roughly the perspective you would have with the two windows side by side.
   *
   * The timer runs whether or not the worker is working, and that is the point. It used to stop when
   * the worker stopped, on the reasoning that a stopped worker cannot change. Session 019ffa73,
   * 2026-08-14: the worker stopped at 02:02:18Z, the supervisor saw it stop and answered let_it_run,
   * and the two then sat silent for two and a half hours until wassname typed "why stop". let_it_run
   * means do nothing, doing nothing is what a stopped worker does, and with the timer off nothing was
   * left to wake either side. A stopped worker is now looked at again like any other.
   */
  pi.on("turn_start", async (_event: unknown, context: any) => {
    ctx = context;
    // Set again, and before the role check, because a status set during session_start does not
    // survive: the footer had not mounted yet, and nothing redraws it until the next save().
    showStatus();
    if (state.role !== "worker" || !channel || watchTimer) return;
    watchTimer = setInterval(() => {
      if (Date.now() - lastLook < WATCH_INTERVAL_MS) return;
      // A stopped worker is always reported, never skipped as unchanged: an unchanged stopped worker
      // is the state that needs a steer, and nothing else is going to bring it up.
      const idle = ctx.isIdle();
      publishView(ctx, idle ? "looked at again" : "routine check in", sentTurns, !idle).catch((err: Error) => {
        debug("timer look failed", { error: err.message });
      });
    }, WATCH_POLL_MS);
  });

  /** Fires only when no retry, compaction, or queued continuation will run, so the worker is truly done. */
  pi.on("agent_settled", async (_event: unknown, context: any) => {
    ctx = context;
    showStatus();
    debug("agent_settled", { role: state.role, hasChannel: Boolean(channel) });
    if (state.role !== "worker" || !channel) return;
    // The timer keeps running. See the turn_start comment: stopping it here is what let the pairing
    // go silent for two and a half hours after the supervisor answered let_it_run to a stopped worker.
    try {
      // A subagent runs as its own process and leaves no unanswered tool call, so a settled worker
      // can still be spending. Report it and let the supervisor steer; do not wait here.
      const subagents = await childPiProcesses();
      const entries = context.sessionManager.getBranch() as any;
      const progress = progressKey(entries);
      staleReviews = progress === lastProgress ? staleReviews + 1 : 0;
      lastProgress = progress;
      const view = buildView({
        goal: state.goal,
        status: "stopped, just now, no new turn for 0s",
        entries,
        since: sentTurns,
        stale: staleReviews,
        subagents,
        model: workerModel(await ownSession()),
      });
      sentTurns = turnsSince(entries);
      send({ t: "view", to: state.pairedId, view, stopped: true });
      lastLook = Date.now();
      debug("published view", { bytes: Buffer.byteLength(view), to: state.pairedId, stale: staleReviews, subagents });
    } catch (err) {
      // Nothing awaits this handler, so rethrowing would be an unhandled rejection nobody sees,
      // and the supervisor would silently never wake again.
      debug("view publish failed", { error: (err as Error).message });
      context.ui?.notify?.(`intercom-supervisor: could not send the view, ${(err as Error).message}`, "error");
    }
  });

  // ---- supervisor side: one command and three tools ---------------------------------------

  pi.registerCommand("supervise", {
    description: "Supervise the other pi session here: /supervise [goal or path to a goal file], /supervise @name [goal], /supervise goal <new goal>, /supervise look, /supervise stop",
    handler: async (args: string, context: any) => {
      ctx = context;
      const text = args.trim();
      if (!channel) {
        context.ui?.notify?.("intercom-supervisor: intercom is not connected", "error");
        return;
      }
      if (text === "stop") {
        if (state.pairedId) send({ t: "unpair", to: state.pairedId });
        reset("supervision stopped");
        return;
      }
      if (text === "look") {
        if (state.role !== "supervisor") {
          context.ui?.notify?.("intercom-supervisor: not supervising, so there is nothing to look at", "error");
          return;
        }
        send({ t: "look", to: state.pairedId });
        context.ui?.notify?.(`asked ${state.pairedId.slice(0, 8)} for a view`, "info");
        return;
      }
      // Change the goal without breaking the pairing. Stopping and pairing again is the only other
      // way, and that throws away the supervisor's memory of its own steers.
      if (text === "goal" || text.startsWith("goal ")) {
        const goal = readGoal(context.cwd, text.slice(4).trim());
        if (state.role !== "supervisor") {
          context.ui?.notify?.("intercom-supervisor: not supervising, so there is no goal to change", "error");
          return;
        }
        if (!goal) {
          context.ui?.notify?.(`intercom-supervisor: the goal now is: ${state.goal || "not set"}`, "info");
          return;
        }
        state = { ...state, goal };
        save();
        send({ t: "goal", to: state.pairedId, goal }); // the worker heads every view with it
        // Tell the supervisor now, and ask for a view, so it judges the new goal at once instead of
        // waiting up to half an hour for the next look.
        tellSupervisor(GOAL_CHANGED(goal));
        send({ t: "look", to: state.pairedId });
        context.ui?.notify?.(`goal changed: ${goal}`, "info");
        return;
      }
      if (state.role !== "none") {
        context.ui?.notify?.(
          `intercom-supervisor: already paired with ${state.pairedId.slice(0, 8)} as ${state.role}. Run /supervise stop first.`,
          "error",
        );
        return;
      }

      const me = await resolveOwnId();
      const listed = (await channel.listSessions()).filter((s: any) => s.id !== me);
      // The id prefix is the start of the "pi --session <id>" line pi prints in every terminal at
      // startup, so it is something you can match against a window.
      const describe = (rows: any[]) =>
        rows.map((s: any) => `${s.name ?? "(unnamed)"} ${s.id.slice(0, 8)} in ${s.cwd}`).join(", ") || "none";
      const [first, ...rest] = text.split(/\s+/);

      // A target is written @name, so nothing has to be guessed from a goal that has spaces in it.
      // Before this, a first word that matched no session was silently swallowed into the goal:
      // "/supervise LUCID do the thing" set the goal to "LUCID do the thing" and said nothing.
      let worker: any;
      let goal: string;
      if (first.startsWith("@")) {
        // Matched against every session, and no roll call: you named it, so it is the target, and
        // the pair acknowledgement below is the test of whether it can take the job.
        const want = first.slice(1);
        const match = listed.filter((s: any) => s.name === want || s.id === want || s.id.startsWith(want));
        if (match.length !== 1) {
          context.ui?.notify?.(
            `intercom-supervisor: ${match.length} sessions match @${want}. Seen: ${describe(listed)}`,
            "error",
          );
          return;
        }
        worker = match[0];
        goal = readGoal(context.cwd, rest.join(" "));
      } else {
        // Nothing named, so the whole line is the goal and this has to find the worker.
        goal = readGoal(context.cwd, text);
        const here = listed.filter((s: any) => s.cwd === context.cwd);
        if (!here.length) {
          context.ui?.notify?.(`intercom-supervisor: no other session in ${context.cwd}`, "error");
          return;
        }
        // The roll call answers who can actually take the job. One free session is the ordinary
        // case, and it pairs with no question asked.
        const free = await askWhoIsFree();
        const open = here.filter((s: any) => free.has(s.id));
        if (open.length === 1) {
          worker = open[0];
        } else {
          // Otherwise you pick. Everything here is on the list, including the sessions that stayed
          // quiet, because "0 free sessions" is a dead end and a quiet session is sometimes the one
          // you want: a worker that has not been reloaded since this extension changed cannot
          // answer a roll call it does not know about.
          const ordered = [...open, ...here.filter((s: any) => !free.has(s.id))];
          const labels = ordered.map(
            (s: any) => `${s.name ?? "(unnamed)"} ${s.id.slice(0, 8)}${free.has(s.id) ? "" : "  (no answer: child run, paired, gone, or not reloaded)"}`,
          );
          // The goal is a title here, not the goal itself. Yours run to paragraphs of acceptance
          // evidence, and the whole thing above a three-line picker is a wall to read past.
          const picked = await context.ui.select(`which session works on "${firstLine(goal)}"`, labels);
          if (picked === undefined) return; // cancelled, and the notice would say nothing new
          worker = ordered[labels.indexOf(picked)];
        }
      }
      const target = worker.name ?? worker.id.slice(0, 8);

      state = { ...EMPTY_STATE, role: "supervisor", pairedId: worker.id, goal };
      latestView = "";
      save();
      send({ t: "pair", to: state.pairedId, goal });
      // No acknowledgment means the target does not load this extension, or it went away between
      // listSessions and now. Without this the supervisor waits forever for a view and says nothing.
      pairTimer = setTimeout(() => {
        // Unpair first, in case the worker did pair and only the acknowledgment went missing.
        // Otherwise it would keep publishing views to a supervisor that has already given up.
        send({ t: "unpair", to: state.pairedId });
        reset(`intercom-supervisor: ${target} never acknowledged. It probably does not load this extension.`);
      }, PAIR_ACK_TIMEOUT_MS);

      const kept = stripWriters();
      showSupervisorTools(true);

      const { prompt, source } = loadSupervisorPrompt(context.cwd);
      tellSupervisor(BRIEF(prompt, goal, target));
      context.ui?.notify?.(`supervising ${target} (policy: ${source}, tools: ${kept.join(", ")})`, "info");
    },
  });

  /**
   * How many verdicts this look has had, and the cut for a real runaway.
   *
   * Session 019ffa73, every look: let_it_run with a true reason, then a second let_it_run with a
   * different true reason, then "This operation was aborted". Fifteen looks, fifteen aborts. The
   * second call is the model signing off, not a loop, and cutting it made an ordinary look end in
   * an error line. So a repeat is answered instead (LET_IT_RUN_AGAIN), and abort() waits for a
   * count no sign-off explains. Session 019ffa5f reached 645 calls, so the cut stays.
   *
   * Only let_it_run reaches nobody, so only it is safe to answer twice. steer and done act every
   * time they are called, and the repeat warning in steer is what covers a duplicate there.
   */
  const RUNAWAY_VERDICTS = 5;
  let verdictsThisLook = 0;
  const endLook = (context: any) => {
    verdictsThisLook += 1;
    if (verdictsThisLook > RUNAWAY_VERDICTS) context.abort();
    return verdictsThisLook === 1;
  };

  pi.registerTool({
    name: "worker_view",
    label: "Worker view",
    description: "Read the latest view of the worker session: goal, status, files touched, problems, recent turns.",
    parameters: Type.Object({}),
    // Guarded like the rest. Unguarded it answered "the worker has not stopped since pairing" to a
    // session with no pairing at all, which read as confirmation to a worker that had wondered
    // whether it was the supervisor.
    execute: async () => {
      if (state.role !== "supervisor") {
        return { content: [{ type: "text", text: "Not supervising, so there is no worker and no view." }], isError: true };
      }
      return { content: [{ type: "text", text: latestView || "No view received yet. The worker has not stopped since pairing." }] };
    },
  });

  pi.registerTool({
    name: "set_goal",
    label: "Set the goal",
    description:
      "Set the goal when the human did not give one. Infer it from the worker's view. This is announced to the human, who can override it.",
    parameters: Type.Object({ goal: Type.String({ description: "One sentence, the outcome the worker must reach." }) }),
    execute: async (_id: string, params: { goal: string }) => {
      if (state.role !== "supervisor") {
        return { content: [{ type: "text", text: "Not supervising." }], isError: true };
      }
      state = { ...state, goal: params.goal };
      save();
      // The worker holds the copy every view header is built from, so it has to hear this too.
      send({ t: "goal", to: state.pairedId, goal: params.goal });
      // Announced, not silent: the supervisor's own reply is what reaches the human's phone.
      ctx?.ui?.notify?.(`goal set by the supervisor: ${params.goal}`, "info");
      return {
        content: [{
          type: "text",
          text: `Goal set to:

<goal>
${params.goal}
</goal>

This is a goal you inferred, not one the human gave you.
Tell them in your reply, quoting it, so they can correct it.`,
        }],
      };
    },
  });

  pi.registerTool({
    name: "steer",
    label: "Steer worker",
    description: TOOL_STEER,
    parameters: Type.Object({ message: Type.String({ description: "One concrete next action, 1 to 3 sentences." }) }),
    execute: async (_id: string, params: { message: string }, _signal: unknown, _update: unknown, context: any) => {
      if (state.role !== "supervisor") {
        return { content: [{ type: "text", text: "Not supervising. Run /supervise <worker> first." }], isError: true };
      }
      // No goal means no basis to steer. Inventing work is the observed failure, so ask instead.
      if (!state.goal.trim()) {
        return { content: [{ type: "text", text: NO_GOAL }], isError: true };
      }
      // Sent either way. Refusing a repeat would be a stopping rule, and a repeat is sometimes
      // right; the supervisor gets told so it can change approach on the next round.
      // Numbered from the run's total, not from the position in the window, so the number here
      // means the same thing as the one in the review nudge and in "that is instruction N".
      const first = state.steerRounds - state.recentSteers.length + 1;
      const repeat = state.recentSteers
        .map((old, i) => ({ old, n: first + i, score: overlap(old, params.message) }))
        .sort((a, b) => b.score - a.score)[0];

      send({ t: "directive", to: state.pairedId, text: params.message });
      state = {
        ...state,
        steerRounds: state.steerRounds + 1,
        recentSteers: [...state.recentSteers, params.message].slice(-STEER_MEMORY),
      };
      save();

      const warning = repeat && repeat.score >= OVERLAP_WARN
        ? `\nThis says much the same as instruction ${repeat.n}: "${repeat.old}"\nIf the next view shows nothing new, say what evidence makes repeating it worth another round, or change approach.`
        : "";
      endLook(context);
      return { content: [{ type: "text", text: `${STEER_ACK(state.steerRounds)}${warning}` }] };
    },
  });

  /**
   * The third verdict, and the one that stops a fabricated steer.
   *
   * Observed 2026-08-12: with only steer and done on offer, a supervisor with nothing to say wrote
   * "the harness demands a tool call ... the least-bad option is a steer that adds something new",
   * ran a command that printed nothing, then reported a job was at "turn 47 of 80". The real log
   * said 75 of 80. Forcing a verdict every look is what bought that number.
   */
  pi.registerTool({
    name: "let_it_run",
    label: "Let the worker run",
    description: TOOL_LET_IT_RUN,
    parameters: Type.Object({ reason: Type.String({ description: "What in the view says it is on track, in one line." }) }),
    execute: async (_id: string, params: { reason: string }, _signal: unknown, _update: unknown, context: any) => {
      if (state.role !== "supervisor") {
        return { content: [{ type: "text", text: "Not supervising." }], isError: true };
      }
      const first = endLook(context);
      return { content: [{ type: "text", text: first ? LET_IT_RUN_ACK(params.reason, workerStopped) : LET_IT_RUN_AGAIN }] };
    },
  });

  pi.registerTool({
    name: "done",
    label: "Finish supervision",
    description: TOOL_DONE,
    parameters: Type.Object({ reason: Type.String({ description: "The artifact path and the quoted line that proves it." }) }),
    execute: async (_id: string, params: { reason: string }, _signal: unknown, _update: unknown, context: any) => {
      if (state.role !== "supervisor") {
        return { content: [{ type: "text", text: "Not supervising." }], isError: true };
      }
      // "done" while a delegated tool call has no result is a false completion: the worker settled
      // but its subagent or background job is still spending. This proves only that no tracked
      // tool result is missing. A detached process is invisible to it.
      const pending = latestView.match(/^tool calls with no result: (?!none)(.+)$/m)
        ?? latestView.match(/^child pi processes still running: (?!none)(.+)$/m);
      if (pending) {
        return {
          content: [{ type: "text", text: DONE_BLOCKED(pending[1]) }],
          isError: true,
        };
      }
      send({ t: "done", to: state.pairedId, reason: params.reason });
      const rounds = state.steerRounds;
      reset(`supervision finished: ${params.reason}`);
      endLook(context);
      return { content: [{ type: "text", text: `Supervision finished after ${rounds} instructions.` }] };
    },
  });
}
