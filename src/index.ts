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
import {
  INTERCOM_EXTENSION_REGISTER_EVENT,
  type IntercomExtensionChannel,
  type IntercomExtensionEvent,
} from "pi-intercom/extension-api.ts";
import { buildView, progressKey } from "./view.ts";
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
import { BRIEF, NO_GOAL, REVIEW_NUDGE, loadSupervisorPrompt } from "./prompts.ts";

/** How long the supervisor waits for the worker to acknowledge a pair before giving up on it. */
const PAIR_ACK_TIMEOUT_MS = 10_000;

export default function (pi: any) {
  let channel: IntercomExtensionChannel | undefined;
  let state: SuperviseState = { ...EMPTY_STATE };
  let latestView = "";
  let ctx: any;
  let ownId = "";
  /** Worker side: the last progressKey, and how many reviews in a row have matched it. */
  let lastProgress = "";
  let staleReviews = 0;
  /** Supervisor side: cleared when the worker acknowledges the pair. */
  let pairTimer: ReturnType<typeof setTimeout> | undefined;

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

  /** Our own intercom session ID. The broker records pid at registration, so we match on it. */
  async function resolveOwnId(): Promise<string> {
    if (ownId) return ownId;
    const sessions = await channel!.listSessions();
    const mine = sessions.find((s: any) => s.pid === process.pid);
    if (!mine) throw new Error("intercom-supervisor: this session is not registered with the intercom broker");
    ownId = mine.id;
    return ownId;
  }

  /** Everything that ends a pairing goes through here, so no stale view or timer survives it. */
  function reset(note: string) {
    clearTimeout(pairTimer);
    pairTimer = undefined;
    state = { ...EMPTY_STATE };
    latestView = "";
    lastProgress = "";
    staleReviews = 0;
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
      state = { ...EMPTY_STATE, role: "worker", pairedId: from, goal: wire.goal };
      latestView = "";
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

    if (wire.t === "directive" && state.role === "worker") {
      // Busy worker gets "steer": delivered after the current tool calls, before the next LLM call.
      // "followUp" would make it finish the whole task first, so a correction arrives too late to
      // correct anything. Idle worker takes no option, so the message starts a turn.
      pi.sendUserMessage(`[supervisor] ${wire.text}`, ctx?.isIdle() ? undefined : { deliverAs: "steer" });
      return;
    }

    if (wire.t === "view" && state.role === "supervisor") {
      latestView = wire.view;
      pi.sendUserMessage(REVIEW_NUDGE(wire.view, state.steerRounds, state.recentSteers));
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
    pi.events.emit(INTERCOM_EXTENSION_REGISTER_EVENT, {
      namespace: NAMESPACE,
      ownerEligible: false,
      onReady: (value: IntercomExtensionChannel) => {
        channel = value;
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

  pi.on("turn_start", async (_event: unknown, context: any) => {
    ctx = context;
  });

  /** Fires only when no retry, compaction, or queued continuation will run, so the worker is truly done. */
  pi.on("agent_settled", async (_event: unknown, context: any) => {
    ctx = context;
    debug("agent_settled", { role: state.role, hasChannel: Boolean(channel) });
    if (state.role !== "worker" || !channel) return;
    try {
      const entries = context.sessionManager.getBranch() as any;
      const progress = progressKey(entries);
      staleReviews = progress === lastProgress ? staleReviews + 1 : 0;
      lastProgress = progress;
      const view = buildView({ goal: state.goal, status: "idle", entries, stale: staleReviews });
      send({ t: "view", to: state.pairedId, view });
      debug("published view", { bytes: Buffer.byteLength(view), to: state.pairedId, stale: staleReviews });
    } catch (err) {
      // Nothing awaits this handler, so rethrowing would be an unhandled rejection nobody sees,
      // and the supervisor would silently never wake again.
      debug("view publish failed", { error: (err as Error).message });
      context.ui?.notify?.(`intercom-supervisor: could not send the view, ${(err as Error).message}`, "error");
    }
  });

  // ---- supervisor side: one command and three tools ---------------------------------------

  pi.registerCommand("supervise", {
    description: "Supervise another pi session: /supervise <name|id> [goal], or /supervise stop",
    handler: async (args: string, context: any) => {
      ctx = context;
      const text = args.trim();
      if (!channel) {
        context.ui?.notify?.("intercom-supervisor: intercom is not connected", "error");
        return;
      }
      if (text === "stop" || text === "") {
        if (state.pairedId) send({ t: "unpair", to: state.pairedId });
        reset("supervision stopped");
        return;
      }
      if (state.role !== "none") {
        context.ui?.notify?.(
          `intercom-supervisor: already paired with ${state.pairedId.slice(0, 8)} as ${state.role}. Run /supervise stop first.`,
          "error",
        );
        return;
      }

      const [target, ...rest] = text.split(/\s+/);
      const goal = rest.join(" ");
      const sessions = await channel.listSessions();
      const me = await resolveOwnId();
      const matches = sessions.filter((s: any) => s.id !== me && (s.id === target || s.name === target));
      if (matches.length !== 1) {
        const names = sessions.map((s: any) => `${s.name ?? "(unnamed)"} ${s.id.slice(0, 8)}`).join(", ");
        context.ui?.notify?.(`intercom-supervisor: ${matches.length} sessions match "${target}". Seen: ${names}`, "error");
        return;
      }

      state = { ...EMPTY_STATE, role: "supervisor", pairedId: matches[0].id, goal };
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

      const { prompt, source } = loadSupervisorPrompt(context.cwd);
      pi.sendUserMessage(BRIEF(prompt, goal, matches[0].name ?? state.pairedId.slice(0, 8)));
      context.ui?.notify?.(`supervising ${matches[0].name ?? state.pairedId.slice(0, 8)} (policy: ${source})`, "info");
    },
  });

  pi.registerTool({
    name: "worker_view",
    label: "Worker view",
    description: "Read the latest view of the worker session: goal, status, files touched, problems, recent turns.",
    parameters: Type.Object({}),
    execute: async () => ({
      content: [{ type: "text", text: latestView || "No view received yet. The worker has not stopped since pairing." }],
    }),
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
    description: "Send one concrete next action to the worker. It arrives as a user message in the worker session.",
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
      const repeat = state.recentSteers
        .map((old, i) => ({ old, i, score: overlap(old, params.message) }))
        .sort((a, b) => b.score - a.score)[0];

      send({ t: "directive", to: state.pairedId, text: params.message });
      state = {
        ...state,
        steerRounds: state.steerRounds + 1,
        recentSteers: [...state.recentSteers, params.message].slice(-STEER_MEMORY),
      };
      save();

      const warning = repeat && repeat.score >= OVERLAP_WARN
        ? `\nThis says much the same as instruction ${repeat.i + 1}: "${repeat.old}"\nIf the next view shows nothing new, say what evidence makes repeating it worth another round, or change approach.`
        : "";
      return { content: [{ type: "text", text: `Steered. That is instruction ${state.steerRounds}.${warning}` }] };
    },
  });

  pi.registerTool({
    name: "done",
    label: "Finish supervision",
    description: "Declare the goal met and stop supervising. Only call this with quoted evidence from the view.",
    parameters: Type.Object({ reason: Type.String({ description: "The artifact path and the quoted line that proves it." }) }),
    execute: async (_id: string, params: { reason: string }) => {
      if (state.role !== "supervisor") {
        return { content: [{ type: "text", text: "Not supervising." }], isError: true };
      }
      // "done" while a delegated tool call has no result is a false completion: the worker settled
      // but its subagent or background job is still spending. This proves only that no tracked
      // tool result is missing. A detached process is invisible to it.
      const pending = latestView.match(/^tool calls with no result: (?!none)(.+)$/m);
      if (pending) {
        return {
          content: [{ type: "text", text: `Cannot finish: the worker has a tool call with no result yet (${pending[1]}). Wait for the next view.` }],
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
