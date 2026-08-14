/**
 * What the context pruner would have saved on a real overnight pairing.
 *
 * Replays a supervisor session's branch under the same rule as the "context" handler in index.ts:
 * before the oldest of the last LOOKS_KEPT views, a view collapses to VIEW_PRUNED and an assistant
 * message loses its thinking. Reports the context the model reads at each look, so the saving is
 * measured rather than guessed.
 *
 * Usage: npx tsx scripts/measure-prune.ts <supervisor-session.jsonl>
 */
import { readFileSync } from "node:fs";
import { isViewText, VIEW_PRUNED } from "../src/prompts.ts";

const LOOKS_KEPT = 3;
const path = process.argv[2];
if (!path) throw new Error("give a supervisor session jsonl");

const entries = readFileSync(path, "utf-8")
  .split("\n")
  .filter(Boolean)
  .map((l) => JSON.parse(l))
  .filter((e) => e.type === "message");

/** Rough and consistent for both columns, which is all a ratio needs. */
const tokens = (chars: number) => Math.round(chars / 4);
const sizeOf = (parts: any[]) =>
  parts.map((c: any) => c.text ?? c.thinking ?? (c.arguments ? JSON.stringify(c.arguments) : "")).join("").length;
const isView = (m: any) => m.role === "user" && (m.content ?? []).some((c: any) => c.type === "text" && isViewText(c.text));

// Walk the branch one message at a time; at each model call, size the context both ways.
const messages: any[] = [];
const rows: Array<{ look: number; before: number; after: number }> = [];
let look = 0;

for (const entry of entries) {
  messages.push(entry.message);
  if (!isView(entry.message)) continue;
  look += 1;

  const views = messages.flatMap((m, i) => (isView(m) ? [i] : []));
  const cut = views.length > LOOKS_KEPT ? views[views.length - LOOKS_KEPT] : messages.length;
  const before = messages.reduce((n, m) => n + sizeOf(m.content ?? []), 0);
  const after = messages.reduce((n, m, i) => {
    if (i >= cut) return n + sizeOf(m.content ?? []);
    if (isView(m)) return n + VIEW_PRUNED.length;
    if (m.role !== "assistant") return n + sizeOf(m.content ?? []);
    return n + sizeOf((m.content ?? []).filter((c: any) => c.type !== "thinking"));
  }, 0);
  rows.push({ look, before: tokens(before), after: tokens(after) });
}

const last = rows[rows.length - 1];
console.log(`looks: ${rows.length}   looks kept whole: ${LOOKS_KEPT}\n`);
console.log("look   ctx before   ctx after   saved");
for (const r of rows.filter((_, i) => i % 10 === 0 || i === rows.length - 1)) {
  const pct = ((1 - r.after / r.before) * 100).toFixed(0);
  console.log(`${String(r.look).padStart(4)}   ${String(r.before).padStart(10)}   ${String(r.after).padStart(9)}   ${pct.padStart(4)}%`);
}
console.log(`\nfinal look: ${last.before} -> ${last.after} tokens, ${((1 - last.after / last.before) * 100).toFixed(0)}% smaller`);
const sumBefore = rows.reduce((n, r) => n + r.before, 0);
const sumAfter = rows.reduce((n, r) => n + r.after, 0);
console.log(`read across the night: ${sumBefore} -> ${sumAfter} tokens, ${((1 - sumAfter / sumBefore) * 100).toFixed(0)}% less`);
