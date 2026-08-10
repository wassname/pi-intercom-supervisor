/**
 * What the two sessions say to each other over the pi-intercom extension channel.
 *
 * The channel never enters a transcript and never starts a turn, so each side triggers its own
 * turn locally with pi.sendUserMessage after it receives one of these.
 */

export const NAMESPACE = "wassname/pi-supervise/v1";

/** Steer rounds allowed before the loop stops itself. Overnight runs cost money. */
export const MAX_STEER_ROUNDS = Number(process.env.PI_SUPERVISE_MAX_ROUNDS ?? 20);

export type Wire =
  | { t: "pair"; to: string; goal: string }
  | { t: "view"; to: string; view: string }
  | { t: "directive"; to: string; text: string }
  | { t: "done"; to: string; reason: string }
  | { t: "unpair"; to: string };

export function isWire(payload: unknown): payload is Wire {
  if (typeof payload !== "object" || payload === null) return false;
  const { t, to } = payload as Record<string, unknown>;
  return typeof to === "string"
    && (t === "pair" || t === "view" || t === "directive" || t === "done" || t === "unpair");
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
