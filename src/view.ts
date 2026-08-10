/**
 * The worker view: what the supervisor judges from.
 *
 * Built from ctx.sessionManager.getBranch(), which already follows the live leaf path, so a fork
 * or a rewind cannot leave dead entries in here. There is no disk read and no cross-branch merge.
 *
 * The body is pi-vcc's compiler, the same algorithmic compactor the worker can run, called here on
 * the live messages with the worker's last compaction summary as previousSummary. So the view is
 * "compaction summary, merged with everything since". We add what a compactor has no reason to
 * track: unanswered tool calls, tool errors, and whether anything changed since the last review.
 */
import { compile } from "@sting8k/pi-vcc/src/core/summarize.ts";
import { normalize } from "@sting8k/pi-vcc/src/core/normalize.ts";
import { extractFiles } from "@sting8k/pi-vcc/src/extract/files.ts";

/** Entry shapes we read. Only the fields this file touches, taken from real session jsonl. */
export interface Block {
  type: string;
  id?: string;
  text?: string;
  name?: string;
  arguments?: Record<string, unknown>;
}
export interface AgentMsg {
  role: "user" | "assistant" | "toolResult" | string;
  content?: string | Block[];
  toolName?: string;
  toolCallId?: string;
  isError?: boolean;
}
export interface Entry {
  type: string;
  message?: AgentMsg;
  /** Written by whichever compactor the worker runs. VCC's summary lands here too. */
  summary?: string;
  tokensBefore?: number;
}

/** Extension channel payloads cap at 16 KiB, so the view must stay under it. */
export const MAX_VIEW_BYTES = 15000;

function blocks(msg: AgentMsg): Block[] {
  return Array.isArray(msg.content) ? msg.content : [];
}

function textOf(msg: AgentMsg): string {
  if (typeof msg.content === "string") return msg.content;
  return blocks(msg)
    .filter((b) => b.type === "text")
    .map((b) => b.text ?? "")
    .join("\n");
}

/**
 * Tool calls with no matching result on this branch. A settled worker with an unanswered
 * subagent call still has delegated work running, and "done" then means nothing.
 */
export function outstandingWork(entries: Entry[]): string[] {
  const called = new Map<string, string>();
  const answered = new Set<string>();
  for (const entry of entries) {
    const msg = entry.message;
    if (!msg) continue;
    for (const b of blocks(msg)) {
      if (b.type === "toolCall" && b.id) called.set(b.id, b.name ?? "?");
    }
    if (msg.role === "toolResult" && msg.toolCallId) answered.add(msg.toolCallId);
  }
  return [...called].filter(([id]) => !answered.has(id)).map(([, name]) => name);
}

/**
 * Errors the worker has not visibly moved past, most recent last.
 *
 * A later clean result from the same tool clears that tool's earlier errors. Without this, a
 * failure the worker already fixed stays in the view for the rest of a multi-day run, and the
 * supervisor keeps steering about a problem that is gone.
 */
export function problems(entries: Entry[]): string[] {
  const byTool = new Map<string, string[]>();
  for (const entry of entries) {
    const msg = entry.message;
    if (!msg || msg.role !== "toolResult") continue;
    const tool = msg.toolName ?? "tool";
    const body = textOf(msg).trim();
    const exit = body.match(/exit(?:ed with)? (?:code )?([1-9]\d*)/i);

    if (msg.isError) {
      byTool.set(tool, [...(byTool.get(tool) ?? []), `${tool} failed: ${body.slice(0, 200)}`]);
    } else if (exit) {
      byTool.set(tool, [...(byTool.get(tool) ?? []), `${tool} exit ${exit[1]}: ${body.slice(0, 200)}`]);
    } else {
      byTool.delete(tool); // this tool ran clean since, so its earlier errors are stale
    }
  }
  return [...byTool.values()].flat().slice(-8);
}

/** The summary written by whichever compactor the worker runs. Empty when it has not compacted. */
export function compactionSummary(entries: Entry[]): string {
  let summary = "";
  for (const entry of entries) {
    if (entry.type === "compaction" && entry.summary) summary = entry.summary;
  }
  return summary;
}

/**
 * What the worker has changed: the files it wrote, and the distinct errors it hit.
 *
 * Two reviews with the same key mean the last instruction moved nothing. That is evidence for the
 * supervisor, not a rule: re-editing one file while a test still fails looks the same, and is
 * sometimes the right thing to be doing.
 *
 * Read from pi-vcc's extractor rather than from its rendered section, which caps the list at ten
 * paths and would freeze this key on any run long enough to matter. Errors are deduplicated,
 * because the same test failing again is not a new error.
 */
export function progressKey(entries: Entry[]): string {
  const files = extractFiles(normalize(messagesSince(entries) as any));
  const distinct = [...new Set(problems(entries))].sort();
  return [[...files.modified].sort().join(","), [...files.created].sort().join(","), distinct.join("|")].join("||");
}

/**
 * Messages after the worker's last compaction.
 *
 * getBranch keeps the entries a compaction replaced, so handing every message to compile alongside
 * the summary would send the supervisor both copies and spend the byte budget twice.
 */
function messagesSince(entries: Entry[]): AgentMsg[] {
  const lastCompaction = entries.map((e) => e.type).lastIndexOf("compaction");
  return entries
    .slice(lastCompaction + 1)
    .filter((e) => e.type === "message" && e.message)
    .map((e) => e.message!);
}

const VCC_SEPARATOR = "\n\n---\n\n";
/** pi-vcc's section names, in the order formatSummary writes them (its format.ts). */
const VCC_HEADERS = ["Session Goal", "Files And Changes", "Commits", "Outstanding Context", "User Preferences"];

/**
 * pi-vcc's compiled summary, split into its header sections and its brief transcript.
 *
 * compile() writes `sections + "\n\n---\n\n" + brief`, and drops either part when it is empty, so
 * all four combinations are possible. Get this wrong and the header block lands in the transcript,
 * where the byte cut eats the newest turns instead of the oldest.
 */
function vccSections(entries: Entry[]): { headers: string; brief: string } {
  // No previousSummary: compile's merge reads the fresh brief with briefOf, which finds nothing
  // when the fresh messages produced no header sections, and the newest turns vanish. The
  // compaction summary goes into the view above this instead, which loses nothing.
  //
  // compile appends a note telling the reader to call vcc_recall, which the supervisor does not
  // have. Matched on the tool name because wrapLongLines rewraps the note before we see it.
  const compiled = compile({ messages: messagesSince(entries) as any })
    .replace(/\n*-*\n*Use `vcc_recall`[\s\S]*$/, "")
    .trim();
  if (!VCC_HEADERS.some((h) => compiled.startsWith(`[${h}]`))) return { headers: "", brief: compiled };
  const at = compiled.indexOf(VCC_SEPARATOR);
  if (at < 0) return { headers: compiled, brief: "" };
  return { headers: compiled.slice(0, at), brief: compiled.slice(at + VCC_SEPARATOR.length) };
}

export interface ViewInput {
  goal: string;
  status: string;
  entries: Entry[];
  /** Reviews in a row where progressKey did not change. 0 means something changed this time. */
  stale?: number;
}

/** Render the view, and cut it to MAX_VIEW_BYTES so the broker cannot reject it. */
export function buildView({ goal, status, entries, stale = 0 }: ViewInput): string {
  const messages = entries.filter((e) => e.type === "message" && e.message);
  const errors = problems(messages);
  const pending = outstandingWork(messages);
  const { headers, brief } = vccSections(entries);
  const earlier = compactionSummary(entries);

  const head = [
    `# Goal, as the human or the supervisor set it`,
    (goal || "not set").slice(0, 2000),
    ``,
    `# Worker`,
    `status: ${status}`,
    `turns: ${messages.length}`,
    `tool calls with no result: ${pending.length ? pending.join(", ") : "none"}`,
    ...(stale > 0 ? [`no new file, commit or error for ${stale} reviews in a row`] : []),
    ``,
    `# Problems`,
    errors.length ? errors.join("\n") : "none",
    ``,
    // The two sections meet at the compaction: the summary covers everything up to it, pi-vcc
    // covers everything after. Nothing sits in a gap between them, and nothing is sent twice.
    ...(earlier ? [`# Earlier work, summarised by the worker's own compactor`, earlier.slice(0, 6000), ``] : []),
    `# Work since${earlier ? " that summary" : ""}, compiled by pi-vcc`,
    headers,
    ``,
    `# Recent turns`,
  ].join("\n");

  // Oldest brief lines go first, because the newest turns are what the next instruction rests on.
  let lines = brief.split("\n");
  let view = `${head}\n${lines.join("\n")}\n`;
  while (Buffer.byteLength(view, "utf-8") > MAX_VIEW_BYTES && lines.length > 1) {
    lines = lines.slice(1);
    view = `${head}\n[earlier turns cut to fit the channel]\n${lines.join("\n")}\n`;
  }
  if (Buffer.byteLength(view, "utf-8") <= MAX_VIEW_BYTES) return view;
  // The head alone can overflow, on a long goal or many problems. The broker drops anything over
  // 16 KiB and never tells the extension, so the supervisor would go blind. Cut, and say so.
  return `${Buffer.from(view, "utf-8").subarray(0, MAX_VIEW_BYTES - 40).toString("utf-8")}\n[view cut here to fit the channel]\n`;
}
