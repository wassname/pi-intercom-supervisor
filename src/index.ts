/**
 * intercom-supervisor: a supervisor pi session watches a worker pi session and steers it.
 *
 * Load this extension in both sessions. Type /supervise <worker> in the supervisor.
 *
 * Wire: the pi-intercom extension channel carries data without starting a turn, so each side
 * triggers its own turn locally with pi.sendUserMessage. The broker stamps fromSessionId from its
 * own registry, so pairing on that ID cannot be forged by a payload.
 */
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
import { buildView, progressKey, turnsSince } from "./view.ts";
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
  NO_GOAL,
  REVIEW_NUDGE,
  TOOL_DONE,
  TOOL_STEER,
  TOOL_WAIT,
  WAIT_ACK,
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

/** How long the supervisor waits for the worker to acknowledge a pair before giving up on it. */
const PAIR_ACK_TIMEOUT_MS = 10_000;

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
 * worker is offered worker_view, steer, wait and done. Observed 2026-08-12: a worker given an
 * ordinary coding task spent twelve turns reasoning "these are supervisor tools ... so I might be
 * the supervisor for a worker session", called worker_view, and read "the worker has not stopped
 * since pairing" as proof of a pairing it never had.
 */
const SUPERVISOR_TOOLS = ["worker_view", "set_goal", "steer", "wait", "done"];

export default function (pi: any) {
  let channel: IntercomExtensionChannel | undefined;
  let state: SuperviseState = { ...EMPTY_STATE };
  let latestView = "";
  let ctx: any;
  let ownId = "";
  /** Worker side: the last progressKey, and how many reviews in a row have matched it. */
  let lastProgress = "";
  let staleReviews = 0;
  /** Worker side: how many turns the supervisor has already been sent, so views carry only the new ones. */
  let sentTurns = 0;
  /** Worker side: the routine look while a turn runs, and when the last view of any kind went out. */
  let watchTimer: ReturnType<typeof setInterval> | undefined;
  let lastLook = 0;
  let turnStartedAt = 0;
  /** Supervisor side: cleared when the worker acknowledges the pair. */
  let pairTimer: ReturnType<typeof setTimeout> | undefined;
  /** Supervisor side: the tools this session had before supervising took the writers away. */
  let savedTools: string[] | undefined;

  /** PI_SUPERVISOR_DEBUG=1 traces the wire to stderr. The channel is invisible in transcripts. */
  const debug = (event: string, detail: unknown = {}) => {
    if (process.env.PI_SUPERVISOR_DEBUG) console.error(`[intercom-supervisor] ${event} ${JSON.stringify(detail)}`);
  };

  function save() {
    pi.appendEntry(STATE_ENTRY, state);
  }

  function send(message: Wire) {
    if (!channel) throw new Error("intercom-supervisor: intercom channel is not ready");
    channel.publish(message, { audience: "capable" });
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
    savedTools = before;
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
    if (savedTools) {
      pi.setActiveTools(savedTools); // supervising took the writers away, give them back
      savedTools = undefined;
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
    if (wire.to !== me) return;

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
      ctx?.ui?.notify?.(`supervised by ${from.slice(0, 8)}: ${wire.goal}`, "info");
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
      await publishMidRun(ctx, "you asked");
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

  pi.on("session_start", async (_event: unknown, context: any) => {
    ctx = context;
    state = restoreState(context.sessionManager.getEntries());
    // Before anything else, because a worker that can see steer and worker_view starts guessing
    // that it is a supervisor. rejoinOrDrop below may still drop the pairing and hide them again.
    showSupervisorTools(state.role === "supervisor");
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

  /** Publish what the worker looks like right now. Used mid-turn, on a timer and on a signal. */
  async function publishMidRun(context: any, why: string) {
    // Claimed before the await, not after. ps takes long enough that a second timer tick would
    // otherwise start its own look while this one is still waiting.
    lastLook = Date.now();
    const entries = context.sessionManager.getBranch() as any;
    // Checked here too. This view replaces the one done reads, so leaving it out would report
    // "child pi processes still running: none" and unblock done while a subagent is running.
    const subagents = await childPiProcesses();
    const view = buildView({
      goal: state.goal,
      status: `working, ${why}`,
      entries,
      since: sentTurns,
      subagents,
      model: workerModel(await ownSession()),
    });
    sentTurns = turnsSince(entries);
    send({ t: "view", to: state.pairedId, view, stopped: false });
    debug("published mid-run view", { why, to: state.pairedId, sentTurns });
  }

  /**
   * The timer look. A human supervising does not read every token; they wander past every few
   * minutes and interrupt if the work has gone somewhere wrong. This is that, so the supervisor
   * keeps roughly the perspective you would have with the two windows side by side.
   */
  pi.on("turn_start", async (_event: unknown, context: any) => {
    ctx = context;
    if (state.role !== "worker" || !channel || watchTimer) return;
    watchTimer = setInterval(() => {
      if (Date.now() - lastLook < WATCH_INTERVAL_MS) return;
      publishMidRun(ctx, `${Math.round((Date.now() - turnStartedAt) / 1000)}s into this turn`).catch((err: Error) => {
        debug("timer look failed", { error: err.message });
      });
    }, WATCH_POLL_MS);
    turnStartedAt = Date.now();
  });

  /** Fires only when no retry, compaction, or queued continuation will run, so the worker is truly done. */
  pi.on("agent_settled", async (_event: unknown, context: any) => {
    ctx = context;
    debug("agent_settled", { role: state.role, hasChannel: Boolean(channel) });
    if (state.role !== "worker" || !channel) return;
    clearInterval(watchTimer); // the worker stopped, so there is nothing to watch until it starts again
    watchTimer = undefined;
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
        status: "idle",
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
    description: "Supervise the other pi session here: /supervise [goal], /supervise <name|id> [goal], /supervise look, /supervise stop",
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
      if (state.role !== "none") {
        context.ui?.notify?.(
          `intercom-supervisor: already paired with ${state.pairedId.slice(0, 8)} as ${state.role}. Run /supervise stop first.`,
          "error",
        );
        return;
      }

      const me = await resolveOwnId();
      // pi-subagents registers every child run with the broker, under an id starting "subagent".
      // Three of those in one directory made /supervise refuse to pick the one real worker.
      // Steering a subagent is meaningless anyway: it dies when its task ends.
      const others = (await channel.listSessions())
        .filter((s: any) => s.id !== me && !s.id.startsWith("subagent"));
      const [first, ...rest] = text.split(/\s+/);
      const named = others.filter((s: any) => s.id === first || s.name === first);

      // Naming a worker is optional. With one other session in this directory, that is the worker,
      // and everything you typed is the goal. Only a first word that matches a session is a target.
      let worker = named[0];
      let goal = rest.join(" ");
      if (named.length !== 1) {
        const here = others.filter((s: any) => s.cwd === context.cwd);
        if (here.length !== 1) {
          // The id prefix is the start of the "pi --session <id>" line pi prints in every terminal
          // at startup, so it is something you can actually match against a window.
          const seen = others.map((s: any) => `${s.name ?? "(unnamed)"} ${s.id.slice(0, 8)} in ${s.cwd}`).join(", ");
          context.ui?.notify?.(
            `intercom-supervisor: ${here.length} other sessions in ${context.cwd}, so say which. `
            + `Run /name <something> in the worker, then /supervise <something> <goal>, or use the id below. `
            + `Seen: ${seen || "none"}`,
            "error",
          );
          return;
        }
        worker = here[0];
        goal = text;
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
      pi.sendUserMessage(BRIEF(prompt, goal, target));
      context.ui?.notify?.(`supervising ${target} (policy: ${source}, tools: ${kept.join(", ")})`, "info");
    },
  });

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
          text: `Goal set to: ${params.goal}\nThis is a goal you inferred, not one the human gave you.
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
    execute: async (_id: string, params: { message: string }) => {
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
      return { content: [{ type: "text", text: `Steered. That is instruction ${state.steerRounds}.${warning}` }] };
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
    name: "wait",
    label: "Wait, nothing to change",
    description: TOOL_WAIT,
    parameters: Type.Object({ reason: Type.String({ description: "What in the view says it is on track, in one line." }) }),
    execute: async (_id: string, params: { reason: string }) => {
      if (state.role !== "supervisor") {
        return { content: [{ type: "text", text: "Not supervising." }], isError: true };
      }
      return { content: [{ type: "text", text: WAIT_ACK(params.reason) }] };
    },
  });

  pi.registerTool({
    name: "done",
    label: "Finish supervision",
    description: TOOL_DONE,
    parameters: Type.Object({ reason: Type.String({ description: "The artifact path and the quoted line that proves it." }) }),
    execute: async (_id: string, params: { reason: string }) => {
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
      return { content: [{ type: "text", text: `Supervision finished after ${rounds} instructions.` }] };
    },
  });
}
