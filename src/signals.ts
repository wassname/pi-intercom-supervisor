/**
 * Cheap checks that say a worker is stuck, computed from the tail of its own messages.
 *
 * These run on turn_end, after each LLM sub-turn, while the worker is still working. Without them
 * the supervisor only looks when the worker stops, so a worker an hour down the wrong path is not
 * caught until it settles.
 *
 * Ported from @monotykamary/pi-supervisor (MIT), src/state/mid-run-signals.ts. Same two signals and
 * the same thresholds. Two differences: it reads raw session messages rather than pi-vcc's
 * normalize, which drops isError and would silently disable the first signal, and an assistant
 * message between two failures does not break the run of errors, so commentary while thrashing
 * still counts. Both make this catch a little more than the original does.
 */
import { extractPath } from "@sting8k/pi-vcc/src/core/tool-args.ts";
import type { AgentMsg, Block } from "./view.ts";

export interface Signal {
  type: "tool_error" | "file_read_loop";
  detail: string;
}

/** Messages from the tail to look at. */
const SIGNAL_WINDOW = 30;
/** Tool results in a row that failed. */
const CONSECUTIVE_ERROR_THRESHOLD = 5;
/** Reads of one file with no edit to that file in between. */
const FILE_READ_LOOP_THRESHOLD = 5;

const FILE_MUTATION_TOOLS = new Set(["Edit", "Write", "MultiEdit", "edit", "write", "multi_edit"]);
const FILE_READ_TOOLS = new Set(["Read", "View", "read", "read_file"]);

export function detectSignal(messages: AgentMsg[]): Signal | undefined {
  const tail = messages.slice(-SIGNAL_WINDOW);
  return toolErrors(tail) ?? readLoop(tail);
}

const calls = (msg: AgentMsg): Block[] =>
  (Array.isArray(msg.content) ? msg.content : []).filter((b) => b.type === "toolCall");

const textOf = (msg: AgentMsg): string =>
  typeof msg.content === "string"
    ? msg.content
    : (msg.content ?? []).filter((b) => b.type === "text").map((b) => b.text ?? "").join("\n");

/** A run of failed tool results at the very end. A clean result breaks the run. */
function toolErrors(messages: AgentMsg[]): Signal | undefined {
  let consecutive = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.role === "assistant") continue; // the assistant turn between two results is expected
    if (msg.role !== "toolResult") break;
    if (!msg.isError) break;
    consecutive++;
    if (consecutive >= CONSECUTIVE_ERROR_THRESHOLD) {
      return { type: "tool_error", detail: `${msg.toolName ?? "?"}: ${textOf(msg).slice(0, 80)}` };
    }
  }
  return undefined;
}

/** The same file read over and over with no edit to it. */
function readLoop(messages: AgentMsg[]): Signal | undefined {
  const reads = new Map<string, number>();
  for (const msg of messages) {
    for (const call of calls(msg)) {
      const path = extractPath(call.arguments ?? {});
      if (!path || !call.name) continue;
      if (FILE_MUTATION_TOOLS.has(call.name)) {
        reads.delete(path); // an edit means the reading was going somewhere
        continue;
      }
      if (!FILE_READ_TOOLS.has(call.name)) continue;
      // Paging through one file is not a loop, so a read with an offset counts on its own.
      const args = call.arguments ?? {};
      const key = args.offset != null || args.limit != null ? `${path}:${args.offset}-${args.limit}` : path;
      const count = (reads.get(key) ?? 0) + 1;
      reads.set(key, count);
      if (count >= FILE_READ_LOOP_THRESHOLD) return { type: "file_read_loop", detail: path };
    }
  }
  return undefined;
}
