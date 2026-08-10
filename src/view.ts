/**
 * The worker view: what the supervisor judges from.
 *
 * Built from ctx.sessionManager.getBranch(), which already follows the live leaf path, so a fork
 * or a rewind cannot leave dead entries in here.
 */

/** Entry shapes we read. Only the fields this file touches, taken from real session jsonl. */
export interface Block {
  type: string;
  text?: string;
  name?: string;
  arguments?: Record<string, unknown>;
}
export interface AgentMsg {
  role: "user" | "assistant" | "toolResult" | string;
  content?: string | Block[];
  toolName?: string;
  isError?: boolean;
}
export interface Entry {
  type: string;
  message?: AgentMsg;
}

/** Extension channel payloads cap at 16 KiB, so the view must stay under it. */
export const MAX_VIEW_BYTES = 15000;

const WRITE_TOOLS = new Set(["edit", "write", "multi_edit", "apply_patch", "notebook_edit"]);
const PATH_KEYS = ["path", "file_path", "filePath", "file"];

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

function pathOf(args: Record<string, unknown> | undefined): string | undefined {
  if (!args) return undefined;
  for (const key of PATH_KEYS) {
    const value = args[key];
    if (typeof value === "string") return value;
  }
  return undefined;
}

/** Files the worker changed, most recent last, deduplicated. */
export function filesTouched(entries: Entry[]): string[] {
  const seen: string[] = [];
  for (const entry of entries) {
    if (!entry.message) continue;
    for (const b of blocks(entry.message)) {
      if (b.type !== "toolCall" || !b.name || !WRITE_TOOLS.has(b.name)) continue;
      const path = pathOf(b.arguments);
      if (!path) continue;
      const at = seen.indexOf(path);
      if (at >= 0) seen.splice(at, 1);
      seen.push(path);
    }
  }
  return seen;
}

/**
 * Errors the worker has not visibly resolved. A tool error or a non-zero exit is the evidence
 * that catches an agent claiming success while the output says otherwise.
 */
export function problems(entries: Entry[]): string[] {
  const found: string[] = [];
  for (const entry of entries) {
    const msg = entry.message;
    if (!msg || msg.role !== "toolResult") continue;
    const body = textOf(msg).trim();
    if (msg.isError) {
      found.push(`${msg.toolName ?? "tool"} failed: ${body.slice(0, 200)}`);
      continue;
    }
    const exit = body.match(/exit(?:ed with)? (?:code )?([1-9]\d*)/i);
    if (exit) found.push(`${msg.toolName ?? "tool"} exit ${exit[1]}: ${body.slice(0, 200)}`);
  }
  return found;
}

function transcriptLine(msg: AgentMsg): string | undefined {
  if (msg.role === "user") return `USER: ${textOf(msg)}`;
  if (msg.role === "assistant") {
    const said = textOf(msg).trim();
    const calls = blocks(msg)
      .filter((b) => b.type === "toolCall")
      .map((b) => `${b.name}(${pathOf(b.arguments) ?? ""})`);
    const parts = [said, calls.length ? `-> ${calls.join(" ")}` : ""].filter(Boolean);
    return parts.length ? `ASSISTANT: ${parts.join(" ")}` : undefined;
  }
  if (msg.role === "toolResult") {
    return `TOOL ${msg.toolName ?? "?"}: ${textOf(msg).trim().slice(0, 300)}`;
  }
  return undefined;
}

export interface ViewInput {
  goal: string;
  status: string;
  entries: Entry[];
  recentTurns?: number;
}

/** Render the view. Trims the transcript from the front until it fits MAX_VIEW_BYTES. */
export function buildView({ goal, status, entries, recentTurns = 24 }: ViewInput): string {
  const messages = entries.filter((e) => e.type === "message" && e.message);
  const files = filesTouched(messages).slice(-12);
  const errors = problems(messages.slice(-40));

  const head = [
    `# Goal`,
    (goal || "not set").slice(0, 2000),
    ``,
    `# Worker`,
    `status: ${status}`,
    `turns: ${messages.length}`,
    ``,
    `# Files touched`,
    files.length ? files.join("\n") : "none",
    ``,
    `# Problems`,
    errors.length ? errors.join("\n") : "none",
    ``,
    `# Recent conversation`,
  ].join("\n");

  let lines = messages
    .slice(-recentTurns)
    .map((e) => transcriptLine(e.message!))
    .filter((line): line is string => Boolean(line));

  let view = `${head}\n${lines.join("\n")}\n`;
  while (Buffer.byteLength(view, "utf-8") > MAX_VIEW_BYTES && lines.length > 1) {
    lines = lines.slice(1);
    view = `${head}\n[earlier turns trimmed]\n${lines.join("\n")}\n`;
  }
  // The head can still be long on its own (many files, many problems). The broker rejects anything
  // over 16 KiB and the extension never hears about it, so cut hard rather than go blind.
  if (Buffer.byteLength(view, "utf-8") > MAX_VIEW_BYTES) {
    view = `${Buffer.from(view, "utf-8").subarray(0, MAX_VIEW_BYTES - 20).toString("utf-8")}\n[view truncated]\n`;
  }
  return view;
}
