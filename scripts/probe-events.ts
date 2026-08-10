/** One cheap pi run in rpc mode, printing every event type it emits. Tells us the real event names. */
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "pi-probe-"));
const proc = spawn("pi", ["--mode", "rpc", "--session-dir", dir, "-n", "probe", "-e", resolve(import.meta.dirname, "../src/index.ts")], {
  cwd: dir,
  stdio: ["pipe", "pipe", "pipe"],
});

const seen: string[] = [];
let buffer = "";
proc.stdout.on("data", (chunk: Buffer) => {
  buffer += chunk.toString();
  const lines = buffer.split("\n");
  buffer = lines.pop() ?? "";
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      const e = JSON.parse(line);
      const label = e.type === "event" ? `event:${e.event?.type}` : e.type;
      seen.push(label);
      console.log(label, JSON.stringify(e).slice(0, 120));
    } catch {
      console.log("[unparsed]", line.slice(0, 120));
    }
  }
});
proc.stderr.on("data", (c: Buffer) => console.log("[stderr]", c.toString().trim().slice(0, 200)));

setTimeout(() => proc.stdin.write(`${JSON.stringify({ id: "p1", type: "prompt", message: "Say the single word: ready" })}\n`), 5000);
setTimeout(() => {
  console.log("\n=== event types seen ===");
  console.log([...new Set(seen)].join("\n"));
  proc.kill();
  process.exit(0);
}, 90000);
