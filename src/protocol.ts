/**
 * What the two sessions say to each other over the pi-intercom extension channel.
 *
 * The channel never enters a transcript and never starts a turn, so each side triggers its own
 * turn locally with pi.sendUserMessage after it receives one of these.
 */

export const NAMESPACE = "wassname/pi-intercom-supervisor/v1";

/**
 * Steer rounds allowed before the loop stops itself. Overnight runs cost money.
 * A bad value must crash here: NaN or Infinity would make `rounds >= cap` always false, which is a
 * cap that silently does nothing.
 */
export const MAX_STEER_ROUNDS = readCap(process.env.PI_SUPERVISOR_MAX_ROUNDS);

export function readCap(raw: string | undefined): number {
  if (raw === undefined) return 20;
  const cap = Number(raw);
  if (!Number.isInteger(cap) || cap < 1) {
    throw new Error(`PI_SUPERVISOR_MAX_ROUNDS must be a whole number of 1 or more, got ${JSON.stringify(raw)}`);
  }
  return cap;
}

export type Wire =
  | { t: "pair"; to: string; goal: string }
  | { t: "view"; to: string; view: string }
  | { t: "directive"; to: string; text: string }
  | { t: "done"; to: string; reason: string }
  | { t: "unpair"; to: string };

/** Validates the field each kind carries, so a malformed peer cannot inject "[supervisor] undefined". */
export function isWire(payload: unknown): payload is Wire {
  if (typeof payload !== "object" || payload === null) return false;
  const { t, to, goal, view, text, reason } = payload as Record<string, unknown>;
  if (typeof to !== "string") return false;
  if (t === "pair") return typeof goal === "string";
  if (t === "view") return typeof view === "string";
  if (t === "directive") return typeof text === "string" && text.trim().length > 0;
  if (t === "done") return typeof reason === "string";
  return t === "unpair";
}

export interface SuperviseState {
  role: "none" | "worker" | "supervisor";
  /** Intercom session ID of the other side. The broker stamps this, so it cannot be forged. */
  pairedId: string;
  goal: string;
  steerRounds: number;
}

export const EMPTY_STATE: SuperviseState = { role: "none", pairedId: "", goal: "", steerRounds: 0 };

/** Session entry type used to persist state, so a compaction or reload cannot reset the count. */
export const STATE_ENTRY = "supervise-state";

/** Rebuild state from session entries. The last one written wins. */
export function restoreState(entries: Array<{ type: string; customType?: string; data?: unknown }>): SuperviseState {
  let state = EMPTY_STATE;
  for (const entry of entries) {
    if (entry.type === "custom" && entry.customType === STATE_ENTRY && entry.data) {
      state = entry.data as SuperviseState;
    }
  }
  return state;
}
