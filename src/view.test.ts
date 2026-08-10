import test from "node:test";
import assert from "node:assert/strict";
import { MAX_VIEW_BYTES, buildView, filesTouched, problems, type Entry } from "./view.ts";

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

test("filesTouched lists write tool paths, most recent last, no duplicates", () => {
  const entries = [
    assistant("editing", [{ name: "edit", args: { path: "src/a.ts" } }]),
    assistant("reading", [{ name: "read", args: { path: "src/never.ts" } }]),
    assistant("writing", [{ name: "write", args: { file_path: "docs/b.md" } }]),
    assistant("again", [{ name: "edit", args: { path: "src/a.ts" } }]),
  ];
  assert.deepEqual(filesTouched(entries), ["docs/b.md", "src/a.ts"]);
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

test("buildView reports the goal, the counts, and the problems", () => {
  const view = buildView({
    goal: "make the table",
    status: "idle",
    entries: [assistant("done", [{ name: "write", args: { path: "results.md" } }]), toolResult("bash", "exit code 2")],
  });
  assert.match(view, /# Goal\nmake the table/);
  assert.match(view, /status: idle/);
  assert.match(view, /turns: 2/);
  assert.match(view, /results\.md/);
  assert.match(view, /bash exit 2/);
});

test("buildView stays under the 16 KiB channel limit and says it trimmed", () => {
  const long = Array.from({ length: 400 }, (_, i) => assistant(`turn ${i} ${"x".repeat(400)}`));
  const view = buildView({ goal: "g", status: "idle", entries: long, recentTurns: 400 });
  assert.ok(Buffer.byteLength(view, "utf-8") <= MAX_VIEW_BYTES, `view was ${Buffer.byteLength(view)} bytes`);
  assert.match(view, /\[earlier turns trimmed\]/);
});

test("the real forked fixture has a live branch shorter than the file", async () => {
  // This only checks the fixture is still a fork. Whether pi-supervise reads the live branch is
  // tested in index.test.ts, where getBranch and getEntries return different things. An earlier
  // version asserted on the rendered view and passed even with every abandoned entry included,
  // because byte trimming removed them anyway.
  const { parseSessionEntries, buildContextEntries } = await import("@earendil-works/pi-coding-agent");
  const { readFileSync } = await import("node:fs");
  const fixture = new URL("../test/forked-session.jsonl", import.meta.url).pathname;

  const all = parseSessionEntries(readFileSync(fixture, "utf-8")).filter((e: any) => e.type !== "session");
  const byId = new Map(all.map((e: any) => [e.id, e]));
  const leaf = all[all.length - 1] as any;
  const branch = buildContextEntries(all as any, leaf.id, byId as any);

  assert.equal(all.length, 400);
  assert.equal(branch.length, 377);
  assert.ok(branch.length < all.length, "the fixture must still contain an abandoned branch");
});

test("a long goal cannot push the view past the broker limit", () => {
  const view = buildView({ goal: "x".repeat(60000), status: "idle", entries: [assistant("hi")] });
  assert.ok(Buffer.byteLength(view, "utf-8") <= MAX_VIEW_BYTES, `view was ${Buffer.byteLength(view)} bytes`);
});
