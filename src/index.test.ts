import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { INTERCOM_EXTENSION_REGISTER_EVENT } from "pi-intercom/extension-api.ts";
import extension from "./index.ts";
import { STATE_ENTRY, STEER_MEMORY, isWire, restoreState } from "./protocol.ts";

test("a directive with no text is rejected, so the worker never sees undefined", () => {
  assert.equal(isWire({ t: "directive", to: "x", text: "do it" }), true);
  assert.equal(isWire({ t: "directive", to: "x" }), false);
  assert.equal(isWire({ t: "directive", to: "x", text: "   " }), false);
  assert.equal(isWire({ t: "view", to: "x" }), false);
  assert.equal(isWire({ t: "pair", to: "x", goal: "g" }), true);
});

const WORKER_ID = "session-worker";
const SUPER_ID = "session-supervisor";

/** Fake ExtensionAPI, same shape as pi-intercom's own test harness. */
function harness(ownId: string, { entries = [] as any[], isIdle = true, branch = undefined as any[] | undefined } = {}) {
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
      // Deliberately different from getEntries, so a test can tell which one the view reads.
      getBranch: () => branch ?? entries,
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

test("a directive to a busy worker interrupts, instead of waiting for the whole task", async () => {
  // Seen in a real run: the supervisor corrected the worker mid-task and the correction never
  // arrived, because followUp waits for the agent to finish everything.
  const worker = harness(WORKER_ID, { isIdle: false });
  await worker.start();
  worker.deliver(SUPER_ID, { t: "pair", to: WORKER_ID, goal: "g" });
  await new Promise((r) => setTimeout(r, 5));

  worker.deliver(SUPER_ID, { t: "directive", to: WORKER_ID, text: "it is Cthulhu, not clutho" });
  await new Promise((r) => setTimeout(r, 5));

  assert.equal(worker.userMessages.length, 1);
  assert.deepEqual(worker.userMessages[0].options, { deliverAs: "steer" });
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

test("the view is built from the live branch, not from every entry in the session", async () => {
  // An abandoned fork leaves entries in getEntries that getBranch drops. Reading the wrong one
  // makes the supervisor judge work that was undone.
  const worker = harness(WORKER_ID, {
    entries: [message("user", "ABANDONED after a rewind"), message("user", "kept on the live branch")],
    branch: [message("user", "kept on the live branch")],
  });
  await worker.start();
  worker.deliver(SUPER_ID, { t: "pair", to: WORKER_ID, goal: "g" });
  await new Promise((r) => setTimeout(r, 5));

  await worker.settle();
  const view = worker.published.find((p) => p.t === "view");
  assert.match(view.view, /kept on the live branch/);
  assert.doesNotMatch(view.view, /ABANDONED after a rewind/);
});

test("an unpaired session publishes nothing on settle", async () => {
  const lone = harness(WORKER_ID, { entries: [message("user", "hi")] });
  await lone.start();
  await lone.settle();
  assert.deepEqual(lone.published, []);
});

test("supervision never stops itself: no round limit at all", async () => {
  // wassname: "I want no budget at all! I want long until human stops". Ending early is the
  // failure this extension exists to prevent, so a cap would be a competing objective.
  const sup = harness(SUPER_ID);
  await sup.start();
  await sup.run("supervise", "worker do the thing");

  const steer = sup.tools.get("steer")!;
  for (let i = 0; i < 200; i++) {
    const result = await steer.execute("id", { message: `instruction ${i}` }, undefined, undefined, sup.ctx);
    assert.ok(!result.isError, `instruction ${i} must be allowed, got ${result.content[0].text}`);
  }
});

test("goal, pairing and the steer count all survive a reload together", async () => {
  const first = harness(SUPER_ID);
  await first.start();
  await first.run("supervise", "worker make the results table");
  const steer = first.tools.get("steer")!;
  for (let i = 0; i < 3; i++) {
    await steer.execute("id", { message: `instruction ${i}` }, undefined, undefined, first.ctx);
  }

  const carried = first.appended
    .filter((e) => e.type === STATE_ENTRY)
    .map((e) => ({ type: "custom", customType: e.type, data: e.data }));
  const restored = restoreState(carried);
  assert.equal(restored.goal, "make the results table");
  assert.equal(restored.pairedId, WORKER_ID);
  assert.equal(restored.steerRounds, 3);
  assert.deepEqual(restored.recentSteers, ["instruction 0", "instruction 1", "instruction 2"]);
});

test("the supervisor is shown its recent instructions, so it can see a loop after compaction", async () => {
  const sup = harness(SUPER_ID);
  await sup.start();
  await sup.run("supervise", "worker fix the tests");
  const steer = sup.tools.get("steer")!;
  for (let i = 0; i < STEER_MEMORY + 3; i++) {
    await steer.execute("id", { message: `instruction ${i}` }, undefined, undefined, sup.ctx);
  }

  sup.userMessages.length = 0;
  sup.deliver(WORKER_ID, { t: "view", to: SUPER_ID, view: "# Goal\nfix the tests\n\noutstanding work: none\n" });
  await new Promise((r) => setTimeout(r, 5));

  const nudge = sup.userMessages.at(-1)!.content;
  assert.match(nudge, /You already sent these instructions/);
  assert.match(nudge, /instruction 8/, "the newest instruction must be shown");
  assert.doesNotMatch(nudge, /instruction 0\b/, "only the last few are kept");
  assert.match(nudge, /no round limit/);
});

test("state written before recentSteers existed still loads", () => {
  const old = [{ type: "custom", customType: STATE_ENTRY, data: { role: "supervisor", pairedId: "w", goal: "g", steerRounds: 4 } }];
  const restored = restoreState(old);
  assert.deepEqual(restored.recentSteers, []);
  assert.equal(restored.steerRounds, 4);
});

test("done unpairs the worker, so it stops publishing views", async () => {
  const worker = harness(WORKER_ID, { entries: [message("user", "hi")] });
  await worker.start();
  worker.deliver(SUPER_ID, { t: "pair", to: WORKER_ID, goal: "g" });
  await new Promise((r) => setTimeout(r, 5));

  await worker.settle();
  assert.equal(worker.published.filter((p) => p.t === "view").length, 1, "paired worker publishes");

  worker.deliver(SUPER_ID, { t: "done", to: WORKER_ID, reason: "results.md line 3" });
  await new Promise((r) => setTimeout(r, 5));

  await worker.settle();
  assert.equal(
    worker.published.filter((p) => p.t === "view").length,
    1,
    "after done the worker must not publish again",
  );
});

test("with no goal the supervisor cannot steer, it must ask the human", async () => {
  // Seen in a real run: started with no goal, the supervisor invented a task for the worker.
  const sup = harness(SUPER_ID);
  await sup.start();
  await sup.run("supervise", "worker"); // no goal given

  const result = await sup.tools.get("steer")!.execute("id", { message: "do something" }, undefined, undefined, sup.ctx);
  assert.ok(result.isError, "steering with no goal must be refused");
  assert.match(result.content[0].text, /No goal is set/);
  assert.match(result.content[0].text, /set_goal/, "it must be told how to bind a goal it inferred");
});

test("set_goal binds an inferred goal, and steering then works", async () => {
  // The human likes goal inference at startup, but a silently invented goal is what went wrong in
  // his first run. So inference has to go through a tool that announces what it chose.
  const sup = harness(SUPER_ID);
  await sup.start();
  await sup.run("supervise", "worker"); // no goal

  const set = await sup.tools
    .get("set_goal")!
    .execute("id", { goal: "print the numbers 1 to 3" }, undefined, undefined, sup.ctx);
  assert.ok(!set.isError);
  assert.match(set.content[0].text, /Tell the human/);
  assert.ok(sup.notices.some((n) => n.includes("print the numbers 1 to 3")), "the human must be told");

  const steer = await sup.tools.get("steer")!.execute("id", { message: "do it" }, undefined, undefined, sup.ctx);
  assert.ok(!steer.isError, `steering should work once a goal is set, got ${steer.content[0].text}`);
});

test("a goal given at pair time still allows steering", async () => {
  const sup = harness(SUPER_ID);
  await sup.start();
  await sup.run("supervise", "worker make the results table");

  const result = await sup.tools.get("steer")!.execute("id", { message: "read the log" }, undefined, undefined, sup.ctx);
  assert.ok(!result.isError, `expected a steer to be allowed, got ${result.content[0].text}`);
});

test("done is refused while the worker has an unanswered tool call", async () => {
  // A settled worker whose subagent call has no result is still spending. "done" would be a lie.
  const sup = harness(SUPER_ID);
  await sup.start();
  await sup.run("supervise", "worker finish the sweep");
  sup.deliver(WORKER_ID, {
    t: "view",
    to: SUPER_ID,
    view: "# Goal\nfinish the sweep\n\n# Worker\nstatus: idle\nturns: 3\noutstanding work: subagent\n",
  });
  await new Promise((r) => setTimeout(r, 5));

  const blocked = await sup.tools.get("done")!.execute("id", { reason: "looks finished" }, undefined, undefined, sup.ctx);
  assert.ok(blocked.isError, "done must be refused while work is outstanding");
  assert.match(blocked.content[0].text, /outstanding work \(subagent\)/);
});

test("done is allowed once nothing is outstanding", async () => {
  const sup = harness(SUPER_ID);
  await sup.start();
  await sup.run("supervise", "worker finish the sweep");
  sup.deliver(WORKER_ID, {
    t: "view",
    to: SUPER_ID,
    view: "# Goal\nfinish the sweep\n\n# Worker\nstatus: idle\nturns: 3\noutstanding work: none\n",
  });
  await new Promise((r) => setTimeout(r, 5));

  const ok = await sup.tools.get("done")!.execute("id", { reason: "results.md line 3 says X" }, undefined, undefined, sup.ctx);
  assert.ok(!ok.isError, `expected done to be allowed, got ${ok.content[0].text}`);
});

test("steer refuses when the session is not supervising", async () => {
  const lone = harness(SUPER_ID);
  await lone.start();
  const result = await lone.tools.get("steer")!.execute("id", { message: "x" }, undefined, undefined, lone.ctx);
  assert.ok(result.isError);
});
