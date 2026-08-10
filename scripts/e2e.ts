/**
 * Tier 3: two real pi processes, the real intercom broker, a real model.
 *
 * Proves the thing tier 1 cannot: that a steer from the supervisor arrives in the worker's real
 * session file as role "user". Costs a few LLM calls, so run it by hand, not in a loop.
 *
 *   npx tsx scripts/e2e.ts [--model openrouter/some-cheap-model]
 */
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const EXT = resolve(import.meta.dirname, "../src/index.ts");
const modelArg = process.argv.indexOf("--model");
const MODEL = modelArg > 0 ? process.argv[modelArg + 1] : undefined;
const root = mkdtempSync(join(tmpdir(), "pi-supervise-e2e-"));
const log: string[] = [];

function say(line: string) {
  console.log(line);
  log.push(line);
}

interface Pi {
  proc: ChildProcess;
  name: string;
  sessionDir: string;
  events: any[];
  send(cmd: object): void;
  waitFor(match: (e: any) => boolean, timeoutMs: number, what: string): Promise<any>;
}

function startPi(name: string): Pi {
  const sessionDir = join(root, name);
  mkdirSync(sessionDir, { recursive: true });
  const args = ["--mode", "rpc", "-e", EXT, "--session-dir", sessionDir, "-n", name];
  if (MODEL) args.push("--model", MODEL);
  const proc = spawn("pi", args, {
    cwd: root,
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, PI_SUPERVISE_DEBUG: "1" },
  });

  const events: any[] = [];
  const listeners: Array<(e: any) => void> = [];
  let buffer = "";
  proc.stdout!.on("data", (chunk: Buffer) => {
    buffer += chunk.toString();
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.trim()) continue;
      let event: any;
      try {
        event = JSON.parse(line);
      } catch {
        continue;
      }
      events.push(event);
      for (const fn of [...listeners]) fn(event);
    }
  });
  proc.stderr!.on("data", (c: Buffer) => {
    for (const text of c.toString().split("\n")) {
      if (text.includes("[pi-supervise]")) say(`[${name}] ${text.trim().slice(0, 400)}`);
    }
  });

  return {
    proc,
    name,
    sessionDir,
    events,
    send(cmd: object) {
      proc.stdin!.write(`${JSON.stringify(cmd)}\n`);
    },
    /** Only events arriving after this call count. Matching history resolved on a stale settle. */
    waitFor(match, timeoutMs, what) {
      return new Promise((resolveP, rejectP) => {
        const timer = setTimeout(() => {
          off();
          rejectP(new Error(`${name}: timed out waiting for ${what} after ${timeoutMs}ms`));
        }, timeoutMs);
        const fn = (e: any) => {
          if (!match(e)) return;
          off();
          resolveP(e);
        };
        const off = () => {
          clearTimeout(timer);
          const at = listeners.indexOf(fn);
          if (at >= 0) listeners.splice(at, 1);
        };
        listeners.push(fn);
      });
    },
  };
}

/** Read the worker's real session file back off disk, which is the evidence that matters. */
function readSession(dir: string): any[] {
  const files = readdirSync(dir, { recursive: true } as any) as string[];
  const jsonl = files.filter((f) => String(f).endsWith(".jsonl")).map((f) => join(dir, String(f)));
  if (jsonl.length === 0) throw new Error(`no session file under ${dir}`);
  const newest = jsonl.sort().at(-1)!;
  return readFileSync(newest, "utf-8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}

const idle = (e: any) => e.type === "agent_settled" || (e.type === "event" && e.event?.type === "agent_settled");

async function main() {
  say(`root: ${root}`);
  say(`extension: ${EXT}`);
  say(`model: ${MODEL ?? "(pi default)"}`);

  const worker = startPi("worker");
  const supervisor = startPi("supervisor");
  await new Promise((r) => setTimeout(r, 6000)); // let both register with the intercom broker

  say("\n--- 1. supervisor pairs to the worker ---");
  supervisor.send({ id: "pair", type: "prompt", message: "/supervise worker print the numbers 1 to 3" });
  await supervisor.waitFor((e) => e.id === "pair" && e.type === "response", 30000, "pair response");
  await new Promise((r) => setTimeout(r, 4000));

  say("--- 2. worker does a turn and settles ---");
  worker.send({ id: "w1", type: "prompt", message: "Say the single word: ready" });
  await worker.waitFor(idle, 180000, "worker settle");
  say("worker settled, view should now be at the supervisor");

  say("--- 3. supervisor reviews and steers ---");
  // The review turn is a fresh settle, and the steer needs a worker turn after it.
  await supervisor.waitFor(idle, 240000, "supervisor review turn").catch((e) => say(e.message));
  // Optional: the worker often settles before we start listening, so a timeout here is not a failure.
  await worker.waitFor(idle, 60000, "worker turn after the steer").catch(() => say("(worker had already settled)"));
  await new Promise((r) => setTimeout(r, 3000));

  say("--- 4. read the worker session file ---");
  const entries = readSession(worker.sessionDir);
  const users = entries.filter(
    (e) => e.type === "message" && e.message?.role === "user",
  );
  const steer = users.find((e) => JSON.stringify(e.message.content).includes("[supervisor]"));

  say(`worker entries      : ${entries.length}`);
  say(`worker user messages: ${users.length}`);
  if (steer) {
    say("\nPASS: a supervisor steer is in the worker session as role user");
    say(JSON.stringify(steer, null, 1).slice(0, 900));
  } else {
    say("\nFAIL: no user message containing [supervisor] in the worker session");
    for (const u of users) say(`  user: ${JSON.stringify(u.message.content).slice(0, 200)}`);
    const supEntries = readSession(supervisor.sessionDir);
    say(`\nsupervisor entries: ${supEntries.length}`);
    for (const e of supEntries.slice(-6)) say(`  ${e.type} ${JSON.stringify(e.message ?? e).slice(0, 260)}`);
  }

  worker.proc.kill();
  supervisor.proc.kill();
  mkdirSync(resolve(import.meta.dirname, "../docs/uat"), { recursive: true });
  const out = resolve(import.meta.dirname, "../docs/uat/steer_is_user_message.md");
  writeFileSync(out, `# Tier 3: steer arrives as a user message\n\n\`\`\`\n${log.join("\n")}\n\`\`\`\n`);
  say(`\nwrote ${out}`);
  process.exit(steer ? 0 : 1);
}

main().catch((err) => {
  say(`ERROR: ${err.message}`);
  process.exit(1);
});
