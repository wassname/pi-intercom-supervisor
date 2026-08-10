/**
 * What the two sessions say to each other over the pi-intercom extension channel.
 *
 * The channel never enters a transcript and never starts a turn, so each side triggers its own
 * turn locally with pi.sendUserMessage after it receives one of these.
 */

export const NAMESPACE = "wassname/pi-intercom-supervisor/v1";

// No round cap, no budget, on purpose. Supervision runs until the human stops it with
// /supervise stop, because premature stopping is the failure this whole thing exists to prevent
// (wassname's SUPERVISOR.md, citing arXiv:2410.07095: 8.7% vs 0.8% on MLE-bench).

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
  /** Recent steer texts, so the supervisor can see repetition after its own context is compacted. */
  recentSteers: string[];
}

export const EMPTY_STATE: SuperviseState = {
  role: "none",
  pairedId: "",
  goal: "",
  steerRounds: 0,
  recentSteers: [],
};

/** How many past steers to keep and show back. Enough to spot a loop, small enough to stay cheap. */
export const STEER_MEMORY = 6;

/** Session entry type used to persist state, so a compaction or reload cannot reset the count. */
export const STATE_ENTRY = "supervise-state";

/** Rebuild state from session entries. The last one written wins. */
export function restoreState(entries: Array<{ type: string; customType?: string; data?: unknown }>): SuperviseState {
  let state = EMPTY_STATE;
  for (const entry of entries) {
    if (entry.type === "custom" && entry.customType === STATE_ENTRY && entry.data) {
      // Merge over the defaults so a record written before a field existed still loads.
      state = { ...EMPTY_STATE, ...(entry.data as Partial<SuperviseState>) };
    }
  }
  return state;
}
