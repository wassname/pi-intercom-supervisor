import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { INTERCOM_EXTENSION_REGISTER_EVENT } from "pi-intercom/extension-api.ts";
import extension from "./index.ts";
import { MAX_STEER_ROUNDS, STATE_ENTRY, restoreState } from "./protocol.ts";

const WORKER_ID = "session-worker";
const SUPER_ID = "session-supervisor";

/** Fake ExtensionAPI, same shape as pi-intercom's own test harness. */
function harness(ownId: string, { entries = [] as any[], isIdle = true } = {}) {
  const bus = new EventEmitter();
  const handlers = new Map<string, Array<(e: any, c: any) => any>>();
  const commands = new Map<string, (args: string, ctx: any) => any>();
  const tools = new Map<string, any>();
  const appended: Array<{ type: string; data: any }> = [];
  const userMessages: Array<{ content: string; options?: any }> = [];
  const published: any[] = [];
  const notices: string[] = [];
  let onEvent: (e: any) => void = () => {};

  const channel = {
    namespace: "test",
    snapshot: () => ({ connected: true, supported: true }),
    publish: (payload: unknown) => published.push(payload),
    commitState: () => {},
    listSessions: async () => [
      { id: ownId, pid: process.pid, name: ownId === WORKER_ID ? "worker" : "supervisor" },
      { id: ownId === WORKER_ID ? SUPER_ID : WORKER_ID, pid: process.pid + 1, name: ownId === WORKER_ID ? "supervisor" : "worker" },
    ],
  };

  const pi = {
    events: {
      emit: (channelName: string, payload: any) => {
        if (channelName === INTERCOM_EXTENSION_REGISTER_EVENT) {
          onEvent = payload.onEvent;
          payload.onReady(channel);
        }
        bus.emit(channelName, payload);
      },
      on: (name: string, fn: any) => bus.on(name, fn),
    },
    on: (event: string, fn: any) => {
      handlers.set(event, [...(handlers.get(event) ?? []), fn]);
    },
    registerCommand: (name: string, opts: any) => commands.set(name, opts.handler),
    registerTool: (tool: any) => tools.set(tool.name, tool),
    appendEntry: (type: string, data: any) => appended.push({ type, data }),
    sendUserMessage: (content: string, options?: any) => userMessages.push({ content, options }),
  };

  const ctx = {
    cwd: process.cwd(),
    isIdle: () => isIdle,
    ui: { notify: (m: string) => notices.push(m) },
    sessionManager: {
      getSessionId: () => ownId,
      getEntries: () => entries,
      getBranch: () => entries,
    },
  };

  return {
    pi,
    ctx,
    tools,
    appended,
    userMessages,
    published,
    notices,
    async start() {
      extension(pi as any);
      for (const fn of handlers.get("session_start") ?? []) await fn({}, ctx);
    },
    async settle() {
      for (const fn of handlers.get("agent_settled") ?? []) await fn({}, ctx);
    },
    async run(command: string, args: string) {
      await commands.get(command)!(args, ctx);
    },
    /** Deliver a wire message as if it came from another session, with a broker-stamped sender. */
    deliver(fromSessionId: string, payload: unknown) {
      onEvent({ type: "message", fromSessionId, payload });
    },
  };
}

const message = (role: string, text: string) => ({
  type: "message",
  message: { role, content: [{ type: "text", text }] },
});

test("a directive from the paired supervisor becomes a real user message", async () => {
  const worker = harness(WORKER_ID);
  await worker.start();
  worker.deliver(SUPER_ID, { t: "pair", to: WORKER_ID, goal: "make the table" });
  await new Promise((r) => setTimeout(r, 5));

  worker.deliver(SUPER_ID, { t: "directive", to: WORKER_ID, text: "read the log first" });
  await new Promise((r) => setTimeout(r, 5));

  assert.equal(worker.userMessages.length, 1);
  assert.equal(worker.userMessages[0].content, "[supervisor] read the log first");
  // Idle worker takes no deliverAs, so the message triggers a turn instead of queueing forever.
  assert.equal(worker.userMessages[0].options, undefined);
});

test("a directive from an unpaired session is dropped", async () => {
  const worker = harness(WORKER_ID);
  await worker.start();
  worker.deliver(SUPER_ID, { t: "pair", to: WORKER_ID, goal: "g" });
  await new Promise((r) => setTimeout(r, 5));

  worker.deliver("session-impostor", { t: "directive", to: WORKER_ID, text: "rm -rf /" });
  await new Promise((r) => setTimeout(r, 5));

  assert.deepEqual(worker.userMessages, []);
});

test("a second pair request is ignored while already paired", async () => {
  const worker = harness(WORKER_ID);
  await worker.start();
  worker.deliver(SUPER_ID, { t: "pair", to: WORKER_ID, goal: "first" });
  await new Promise((r) => setTimeout(r, 5));
  worker.deliver("session-impostor", { t: "pair", to: WORKER_ID, goal: "second" });
  await new Promise((r) => setTimeout(r, 5));

  worker.deliver("session-impostor", { t: "directive", to: WORKER_ID, text: "obey me" });
  await new Promise((r) => setTimeout(r, 5));
  assert.deepEqual(worker.userMessages, []);
});

test("a message addressed to a different session is ignored", async () => {
  const worker = harness(WORKER_ID);
  await worker.start();
  worker.deliver(SUPER_ID, { t: "pair", to: "some-other-worker", goal: "not for us" });
  await new Promise((r) => setTimeout(r, 5));

  worker.deliver(SUPER_ID, { t: "directive", to: WORKER_ID, text: "hello" });
  await new Promise((r) => setTimeout(r, 5));
  assert.deepEqual(worker.userMessages, []);
});

test("on settle the worker publishes a view built from the live branch", async () => {
  const worker = harness(WORKER_ID, { entries: [message("user", "do the thing"), message("assistant", "done")] });
  await worker.start();
  worker.deliver(SUPER_ID, { t: "pair", to: WORKER_ID, goal: "the goal" });
  await new Promise((r) => setTimeout(r, 5));

  await worker.settle();
  const view = worker.published.find((p) => p.t === "view");
  assert.ok(view, "expected a view publish");
  assert.equal(view.to, SUPER_ID);
  assert.match(view.view, /# Goal\nthe goal/);
  assert.match(view.view, /USER: do the thing/);
});

test("an unpaired session publishes nothing on settle", async () => {
  const lone = harness(WORKER_ID, { entries: [message("user", "hi")] });
  await lone.start();
  await lone.settle();
  assert.deepEqual(lone.published, []);
});

test("the steer cap stops the loop, and the count survives a reload", async () => {
  const sup = harness(SUPER_ID);
  await sup.start();
  await sup.run("supervise", "worker do the thing");

  const steer = sup.tools.get("steer")!;
  for (let i = 0; i < MAX_STEER_ROUNDS; i++) {
    const result = await steer.execute("id", { message: `round ${i}` }, undefined, undefined, sup.ctx);
    assert.ok(!result.isError, `round ${i} should be allowed`);
  }
  const blocked = await steer.execute("id", { message: "one too many" }, undefined, undefined, sup.ctx);
  assert.ok(blocked.isError, "the cap must refuse the next steer");
  assert.match(blocked.content[0].text, /cap reached/i);

  // The count is written to session entries, so a compaction or reload cannot reset it.
  const persisted = sup.appended.filter((e) => e.type === STATE_ENTRY);
  const restored = restoreState(persisted.map((e) => ({ type: "custom", customType: e.type, data: e.data })));
  assert.equal(restored.steerRounds, MAX_STEER_ROUNDS);
  assert.equal(restored.pairedId, WORKER_ID);
});

test("steer refuses when the session is not supervising", async () => {
  const lone = harness(SUPER_ID);
  await lone.start();
  const result = await lone.tools.get("steer")!.execute("id", { message: "x" }, undefined, undefined, lone.ctx);
  assert.ok(result.isError);
});
