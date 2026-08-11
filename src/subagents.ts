/**
 * Child pi processes, so a settled worker with a subagent still running is not called finished.
 *
 * The in-session check only sees tool calls that never got a result. A subagent spawned as its own
 * process leaves no such trace, so the worker settles and the view looks quiet.
 *
 * Ported from @monotykamary/pi-supervisor (MIT), src/subagent-detector.ts. Extension agnostic: it
 * does not matter who spawned them. Nothing is caught here, so a broken ps is loud.
 */
import { exec } from "node:child_process";
import { promisify } from "node:util";

const execAsync = promisify(exec);

/** How long to wait for subagents before publishing anyway, so the supervisor is never left blind. */
export const SUBAGENT_WAIT_MS = 120_000;
const POLL_MS = 2000;

export async function childPiProcesses(): Promise<number[]> {
  if (process.platform !== "darwin" && process.platform !== "linux") return [];
  const { stdout } = await execAsync(`ps -eo ppid,pid,comm | grep -E "\\bpi\\b" || true`);
  return stdout
    .trim()
    .split("\n")
    .map((line) => line.trim().split(/\s+/))
    .filter((parts) => parts.length >= 3 && Number(parts[0]) === process.pid && parts[2] === "pi")
    .map((parts) => Number(parts[1]));
}

/** Poll until no child pi process is left, or the wait runs out. Returns whatever is still running. */
export async function waitForSubagents(timeoutMs = SUBAGENT_WAIT_MS): Promise<number[]> {
  const deadline = Date.now() + timeoutMs;
  let running = await childPiProcesses();
  while (running.length && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, POLL_MS));
    running = await childPiProcesses();
  }
  return running;
}
