/** Print the fork numbers and a real view, for the goal B artifact. */
import { parseSessionEntries, buildContextEntries } from "@earendil-works/pi-coding-agent";
import { readFileSync } from "node:fs";
import { buildView } from "../src/view.ts";

const file = process.argv[2] ?? "test/forked-session.jsonl";
const all = parseSessionEntries(readFileSync(file, "utf-8")).filter((e: any) => e.type !== "session");
const byId = new Map(all.map((e: any) => [e.id, e]));
const leaf: any = all[all.length - 1];
const branch = buildContextEntries(all as any, leaf.id, byId as any);

console.log(`file             : ${file}`);
console.log(`entries in file  : ${all.length}`);
console.log(`entries on branch: ${branch.length}`);
console.log(`abandoned        : ${all.length - branch.length}`);

const view = buildView({ goal: "demo goal", status: "idle", entries: branch as any });
console.log(`view bytes       : ${Buffer.byteLength(view)}  (limit 15000)`);
console.log("--- view ---");
console.log(view.split("\n").slice(0, 22).join("\n"));
