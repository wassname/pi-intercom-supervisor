/**
 * pi-supervise: a supervisor pi session watches a worker pi session and steers it.
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
import { buildView } from "./view.ts";
import {
  EMPTY_STATE,
  MAX_STEER_ROUNDS,
  NAMESPACE,
  STATE_ENTRY,
  isWire,
  restoreState,
  type SuperviseState,
  type Wire,
} from "./protocol.ts";
import { CAP_REACHED, REVIEW_NUDGE } from "./prompts.ts";

export default function (pi: any) {
  let channel: IntercomExtensionChannel | undefined;
  let state: SuperviseState = { ...EMPTY_STATE };
  let latestView = "";
  let ctx: any;
  let ownId = "";

  function save() {
    pi.appendEntry(STATE_ENTRY, state);
  }

  function send(message: Wire) {
    if (!channel) throw new Error("pi-supervise: intercom channel is not ready");
    channel.publish(message, { audience: "capable" });
  }

  /** Our own intercom session ID. The broker records pid at registration, so we match on it. */
  async function resolveOwnId(): Promise<string> {
    if (ownId) return ownId;
    const sessions = await channel!.listSessions();
    const mine = sessions.find((s: any) => s.pid === process.pid);
    if (!mine) throw new Error("pi-supervise: this session is not registered with the intercom broker");
    ownId = mine.id;
    return ownId;
  }

  // ---- inbound, one branch per role ------------------------------------------------------

  async function onWire(from: string, wire: Wire) {
    if (wire.to !== (await resolveOwnId())) return;

    if (wire.t === "pair") {
      if (state.role !== "none") return; // first pairing wins; we cannot authenticate a second one
      state = { role: "worker", pairedId: from, goal: wire.goal, steerRounds: 0 };
      save();
      ctx?.ui?.notify?.(`supervised by ${from.slice(0, 8)}: ${wire.goal}`, "info");
      return;
    }

    if (from !== state.pairedId) return; // ignore anything from a session we are not paired with

    if (wire.t === "directive" && state.role === "worker") {
      pi.sendUserMessage(`[supervisor] ${wire.text}`, ctx?.isIdle() ? undefined : { deliverAs: "followUp" });
      return;
    }

    if (wire.t === "view" && state.role === "supervisor") {
      latestView = wire.view;
      const left = MAX_STEER_ROUNDS - state.steerRounds;
      pi.sendUserMessage(left > 0 ? REVIEW_NUDGE(wire.view, left) : CAP_REACHED(state.steerRounds));
      return;
    }

    if (wire.t === "done" || wire.t === "unpair") {
      state = { ...EMPTY_STATE };
      save();
      ctx?.ui?.notify?.(`supervision ended: ${wire.t === "done" ? wire.reason : "unpaired"}`, "info");
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
          void onWire(event.fromSessionId, event.payload);
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
    if (state.role !== "worker" || !channel) return;
    const view = buildView({
      goal: state.goal,
      status: "idle",
      entries: context.sessionManager.getBranch() as any,
    });
    send({ t: "view", to: state.pairedId, view });
  });

  // ---- supervisor side: one command and three tools ---------------------------------------

  pi.registerCommand("supervise", {
    description: "Supervise another pi session: /supervise <name|id> [goal], or /supervise stop",
    handler: async (args: string, context: any) => {
      ctx = context;
      const text = args.trim();
      if (!channel) {
        context.ui?.notify?.("pi-supervise: intercom is not connected", "error");
        return;
      }
      if (text === "stop" || text === "") {
        if (state.pairedId) send({ t: "unpair", to: state.pairedId });
        state = { ...EMPTY_STATE };
        save();
        context.ui?.notify?.("supervision stopped", "info");
        return;
      }

      const [target, ...rest] = text.split(/\s+/);
      const goal = rest.join(" ");
      const sessions = await channel.listSessions();
      const me = await resolveOwnId();
      const matches = sessions.filter((s: any) => s.id !== me && (s.id === target || s.name === target));
      if (matches.length !== 1) {
        const names = sessions.map((s: any) => `${s.name ?? "(unnamed)"} ${s.id.slice(0, 8)}`).join(", ");
        context.ui?.notify?.(`pi-supervise: ${matches.length} sessions match "${target}". Seen: ${names}`, "error");
        return;
      }

      state = { role: "supervisor", pairedId: matches[0].id, goal, steerRounds: 0 };
      save();
      send({ t: "pair", to: state.pairedId, goal });
      context.ui?.notify?.(`supervising ${matches[0].name ?? state.pairedId.slice(0, 8)}`, "info");
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
    name: "steer",
    label: "Steer worker",
    description: "Send one concrete next action to the worker. It arrives as a user message in the worker session.",
    parameters: Type.Object({ message: Type.String({ description: "One concrete next action, 1 to 3 sentences." }) }),
    execute: async (_id: string, params: { message: string }) => {
      if (state.role !== "supervisor") {
        return { content: [{ type: "text", text: "Not supervising. Run /supervise <worker> first." }], isError: true };
      }
      if (state.steerRounds >= MAX_STEER_ROUNDS) {
        return { content: [{ type: "text", text: CAP_REACHED(state.steerRounds) }], isError: true };
      }
      send({ t: "directive", to: state.pairedId, text: params.message });
      state = { ...state, steerRounds: state.steerRounds + 1 };
      save();
      return {
        content: [{ type: "text", text: `Steered. Round ${state.steerRounds} of ${MAX_STEER_ROUNDS}.` }],
      };
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
      send({ t: "done", to: state.pairedId, reason: params.reason });
      const rounds = state.steerRounds;
      state = { ...EMPTY_STATE };
      save();
      return { content: [{ type: "text", text: `Supervision finished after ${rounds} steer rounds.` }] };
    },
  });
}
