import test from "node:test";
import assert from "node:assert/strict";
import { MAX_VIEW_BYTES, buildView, outstandingWork, problems, progressKey, type Entry } from "./view.ts";

function assistant(text: string, calls: Array<{ name: string; args: Record<string, unknown> }> = []): Entry {
  return {
    type: "message",
    message: {
      role: "assistant",
      content: [
        { type: "text", text },
        ...calls.map((c) => ({ type: "toolCall", name: c.name, arguments: c.args })),
      ],
    },
  };
}

function toolResult(toolName: string, text: string, isError = false): Entry {
  return { type: "message", message: { role: "toolResult", toolName, isError, content: [{ type: "text", text }] } };
}

test("pi-vcc reports the files the worker wrote, and separates them from the ones it read", () => {
  const view = buildView({
    goal: "g",
    status: "idle",
    entries: [
      assistant("editing", [{ name: "edit", args: { path: "src/a.ts" } }]),
      assistant("reading", [{ name: "read", args: { path: "src/never.ts" } }]),
      assistant("writing", [{ name: "write", args: { file_path: "docs/b.md" } }]),
    ],
  });
  assert.match(view, /Modified:.*src\/a\.ts/);
  assert.match(view, /Read:.*src\/never\.ts/);
});

test("progressKey is unchanged when a review produced no new file, commit or error", () => {
  const worked = [assistant("editing", [{ name: "edit", args: { path: "src/a.ts" } }])];
  const talked = [...worked, assistant("I will look into that shortly.")];
  const wroteMore = [...worked, assistant("editing", [{ name: "write", args: { path: "src/b.ts" } }])];
  assert.equal(progressKey(talked), progressKey(worked), "talking is not progress");
  assert.notEqual(progressKey(wroteMore), progressKey(worked), "a new file is progress");
});

test("problems catches a tool error and a non-zero exit, ignores a clean result", () => {
  const found = problems([
    toolResult("bash", "ok, all good"),
    toolResult("bash", "3 failed\nexited with code 1"),
    toolResult("read", "no such file", true),
  ]);
  assert.equal(found.length, 2);
  assert.match(found[0], /^bash exit 1:/);
  assert.match(found[1], /^read failed:/);
});

test("outstandingWork finds tool calls that never got a result", () => {
  const answered: Entry = {
    type: "message",
    message: { role: "toolResult", toolName: "read", toolCallId: "call-1", content: [{ type: "text", text: "ok" }] },
  };
  const entries: Entry[] = [
    { type: "message", message: { role: "assistant", content: [{ type: "toolCall", id: "call-1", name: "read" }] } },
    answered,
    { type: "message", message: { role: "assistant", content: [{ type: "toolCall", id: "call-2", name: "subagent" }] } },
  ];
  assert.deepEqual(outstandingWork(entries), ["subagent"]);
  assert.deepEqual(outstandingWork([entries[0], answered]), []);
});

test("buildView reports a tool call with no result, so done can be refused", () => {
  const busy = buildView({
    goal: "g",
    status: "idle",
    entries: [{ type: "message", message: { role: "assistant", content: [{ type: "toolCall", id: "x", name: "subagent", arguments: {} }] } }],
  });
  assert.match(busy, /^tool calls with no result: subagent$/m);
  const quiet = buildView({ goal: "g", status: "idle", entries: [assistant("all done")] });
  assert.match(quiet, /^tool calls with no result: none$/m);
});

test("the view says how many reviews in a row changed nothing, and says nothing at zero", () => {
  const entries = [assistant("hi")];
  assert.match(buildView({ goal: "g", status: "idle", entries, stale: 3 }), /no new file, commit or error for 3 reviews/);
  assert.doesNotMatch(buildView({ goal: "g", status: "idle", entries }), /reviews in a row/);
});

test("an error is dropped once the same tool runs clean again", () => {
  // Otherwise a failure the worker already fixed stays in the view for the rest of a multi-day run.
  const stale = problems([
    toolResult("bash", "3 failed\nexited with code 1"),
    toolResult("bash", "all tests passed"),
  ]);
  assert.deepEqual(stale, [], "a later clean run of the same tool clears the old failure");

  const live = problems([
    toolResult("bash", "all tests passed"),
    toolResult("bash", "3 failed\nexited with code 1"),
  ]);
  assert.equal(live.length, 1, "the newest failure is still reported");

  const other = problems([toolResult("bash", "exit code 1"), toolResult("read", "fine")]);
  assert.equal(other.length, 1, "a different tool running clean must not clear bash's failure");
});

test("the view merges the worker's compaction summary with the turns after it", () => {
  // pi-vcc's compile() takes the old summary as previousSummary, so nothing between the summary
  // and the newest turn falls in the gap between them.
  const view = buildView({
    goal: "g",
    status: "idle",
    entries: [
      { type: "compaction", summary: "[Session Goal]\n- build the dataset" },
      assistant("carrying on", [{ name: "write", args: { path: "after.md" } }]),
    ],
  });
  assert.match(view, /build the dataset/, "the summary from before the compaction survives");
  assert.match(view, /after\.md/, "so does the work done after it");
});

test("the view does not tell the supervisor to use vcc_recall, a tool it does not have", () => {
  const view = buildView({ goal: "g", status: "idle", entries: [assistant("hi")] });
  assert.doesNotMatch(view, /vcc_recall/);
});

test("bookkeeping tool calls are kept out of the transcript", () => {
  const view = buildView({
    goal: "g",
    status: "idle",
    entries: [
      assistant("planning", [{ name: "TodoWrite", args: {} }]),
      toolResult("TodoWrite", "todo list updated with 5 items"),
      assistant("real work", [{ name: "edit", args: { path: "src/a.ts" } }]),
    ],
  });
  assert.doesNotMatch(view, /todo list updated/);
  assert.match(view, /src\/a\.ts/);
});

test("buildView reports the goal, the counts, and the problems", () => {
  const view = buildView({
    goal: "make the table",
    status: "idle",
    entries: [assistant("done", [{ name: "write", args: { path: "results.md" } }]), toolResult("bash", "exit code 2")],
  });
  assert.match(view, /# Goal, as the human or the supervisor set it\nmake the table/);
  assert.match(view, /status: idle/);
  assert.match(view, /turns: 2/);
  assert.match(view, /results\.md/);
  assert.match(view, /bash exit 2/);
});

test("buildView keeps the newest turns when it has to cut for the channel limit", () => {
  const long = Array.from({ length: 400 }, (_, i) => assistant(`turn ${i} ${"x".repeat(400)}`));
  const view = buildView({ goal: "g", status: "idle", entries: long });
  assert.ok(Buffer.byteLength(view, "utf-8") <= MAX_VIEW_BYTES, `view was ${Buffer.byteLength(view)} bytes`);
  assert.match(view, /turn 399/, "the newest turn must survive the cut");
  assert.doesNotMatch(view, /turn 0 /, "the oldest must be the one dropped");
});

test("pi's own branch logic drops the abandoned fork, on a session file", async () => {
  // Fixture is generated by scripts/make-fixture.ts, so no real transcript lives in this repo.
  // An earlier version of this test asserted on the rendered view, and passed even when fed every
  // abandoned entry, because byte trimming removed them anyway.
  const { parseSessionEntries, buildContextEntries } = await import("@earendil-works/pi-coding-agent");
  const { readFileSync } = await import("node:fs");
  const fixture = new URL("../test/forked-session.jsonl", import.meta.url).pathname;

  const all = parseSessionEntries(readFileSync(fixture, "utf-8")).filter((e: any) => e.type !== "session");
  const byId = new Map(all.map((e: any) => [e.id, e]));
  const leaf = all[all.length - 1] as any;
  const branch = buildContextEntries(all as any, leaf.id, byId as any);

  const asText = (entries: any[]) => JSON.stringify(entries);
  assert.match(asText(all), /ABANDONED/, "the fixture must contain an abandoned branch");
  assert.doesNotMatch(asText(branch), /ABANDONED/, "the live branch must not contain the abandoned fork");
  assert.equal(all.length - branch.length, 22);
});

test("a long goal cannot push the view past the broker limit", () => {
  const view = buildView({ goal: "x".repeat(60000), status: "idle", entries: [assistant("hi")] });
  assert.ok(Buffer.byteLength(view, "utf-8") <= MAX_VIEW_BYTES, `view was ${Buffer.byteLength(view)} bytes`);
});
