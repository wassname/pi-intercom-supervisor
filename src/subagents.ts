/**
 * Child pi processes, so a settled worker with a subagent still running is not called finished.
 *
 * The in-session check only sees tool calls that never got a result. A subagent spawned as its own
 * process leaves no such trace, so the worker settles and the view looks quiet.
 *
 * This is a snapshot, not a wait. The original polls here for up to two minutes, and pi awaits the
 * settle handler (agent-session.js:330), so that holds the worker's own settle for the whole poll.
 * The loop already does the waiting: the supervisor sees the process listed, done is refused, and
 * it steers instead. That leaves the waiting in the transcript where you can read it.
 *
 * Ported from @monotykamary/pi-supervisor (MIT), src/subagent-detector.ts. Extension agnostic: it
 * does not matter who spawned them. Nothing is caught here, so a broken ps is loud.
 */
import { exec } from "node:child_process";
import { promisify } from "node:util";

const execAsync = promisify(exec);

export interface PiProcess {
  pid: number;
  ppid: number;
}

async function piProcesses(): Promise<PiProcess[]> {
  if (process.platform !== "darwin" && process.platform !== "linux") return [];
  const { stdout } = await execAsync(`ps -eo ppid,pid,comm | grep -E "\\bpi\\b" || true`);
  return stdout
    .trim()
    .split("\n")
    .map((line) => line.trim().split(/\s+/))
    .filter((parts) => parts.length >= 3 && parts[2] === "pi")
    .map((parts) => ({ ppid: Number(parts[0]), pid: Number(parts[1]) }));
}

export async function childPiProcesses(): Promise<number[]> {
  return (await piProcesses()).filter((p) => p.ppid === process.pid).map((p) => p.pid);
}

/**
 * Every pi whose parent is another pi: a pi-subagents run, an oracle run, a pi started from a bash
 * call. They all register with the broker like any session, so /supervise offers them as workers.
 *
 * The process tree is the signal because no naming convention holds. pi-subagents sets the intercom
 * id to "subagent-<agent>-<runId>" only when it passes a target; without one the child registers
 * under its own session id, and pi-intercom then names it "subagent-chat-<id>", which is what it
 * calls any session with no name. Observed 2026-08-12: pid 1741129, parent 447663 (LUCID_worker),
 * offered as a second worker in the same directory.
 */
export function spawnedPids(processes: PiProcess[]): Set<number> {
  const all = new Set(processes.map((p) => p.pid));
  return new Set(processes.filter((p) => all.has(p.ppid)).map((p) => p.pid));
}

export async function spawnedPiPids(): Promise<Set<number>> {
  return spawnedPids(await piProcesses());
}
