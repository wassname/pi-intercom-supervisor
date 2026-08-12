import test from "node:test";
import assert from "node:assert/strict";
import { MAX_VIEW_BYTES, buildView, outstandingWork, problems, progressKey, turnsSince, type Entry } from "./view.ts";

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

test("a view carries only the turns the supervisor has not been sent", () => {
  // The supervisor is a real session and keeps every view it read, so re-sending the whole
  // transcript each time is a second copy of what it already has. It grows with every review.
  const entries = [assistant("the first thing I did"), assistant("the second thing I did")];
  const first = buildView({ goal: "g", status: "idle", entries });
  assert.match(first, /the first thing I did/);
  assert.equal(turnsSince(entries), 2);

  entries.push(assistant("the third thing I did"));
  const next = buildView({ goal: "g", status: "idle", entries, since: 2 });
  assert.match(next, /the third thing I did/);
  assert.doesNotMatch(next, /the first thing I did/, "already sent, so it must not go again");
  assert.match(next, /# New turns since your last look \(1 of 3\)/);
});

test("the last two reasoning blocks stay in the narrative, and older ones drop out", () => {
  // Block shape read out of a real session jsonl. pi-vcc's normalize keeps only text and toolCall,
  // so reasoning reaches nobody, although you see it on screen. It belongs beside the tool call it
  // produced, not in a section of its own, because that is the order you read a session in.
  const thinker = (thinking: string, said: string): Entry => ({
    type: "message",
    message: { role: "assistant", content: [{ type: "thinking", thinking }, { type: "text", text: said }] },
  });
  const entries = [
    thinker("TOO OLD TO SEND", "first try"),
    thinker("the bash tool is dead, LET ME TEST READ", "second try"),
    thinker("read works, SO I WILL DELEGATE INSTEAD", "third try"),
  ];

  const view = buildView({ goal: "g", status: "working", entries });
  assert.match(view, /LET ME TEST READ[\s\S]*SO I WILL DELEGATE INSTEAD/, "in order, oldest first");
  assert.match(view, /LET ME TEST READ[\s\S]*second try/, "each thought sits with the turn it produced");
  assert.doesNotMatch(view, /TOO OLD TO SEND/, "two blocks, or the view becomes a second transcript");
  assert.match(view, /\(thinking\)/, "marked, so the supervisor knows it is reasoning and not speech");
});

test("a compaction restarts the view, so no turn falls into the gap", () => {
  // getBranch keeps the entries a compaction replaced, so the mark now points past the end. Read
  // the wrong slice here and the supervisor silently reads a piece of the old history.
  const entries: Entry[] = [
    assistant("old work"),
    { type: "compaction", summary: "SUMMARY OF THE OLD WORK" },
    assistant("work after the compaction"),
  ];
  const view = buildView({ goal: "g", status: "idle", entries, since: 9 });
  assert.match(view, /The worker compacted, so this view restarts/);
  assert.match(view, /SUMMARY OF THE OLD WORK/);
  assert.match(view, /work after the compaction/);
  assert.equal(turnsSince(entries), 1, "the mark restarts from the compaction, not from the session");
});

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

test("progressKey still sees a new file past pi-vcc's ten path display cap", () => {
  // The rendered section stops at ten paths and says "(+N more)", so reading it there froze this
  // key on exactly the long runs it exists for.
  const many = (n: number) =>
    Array.from({ length: n }, (_, i) => assistant("editing", [{ name: "edit", args: { path: `src/f${i}.ts` } }]));
  assert.notEqual(progressKey(many(13)), progressKey(many(12)), "the 13th file must count as progress");
});

test("a commit counts as progress, even when no file was written since", () => {
  // A worker whose whole turn was committing looked stagnant while the view line claims to count
  // commits.
  const ran = (cmd: string, out: string): Entry[] => [
    assistant("committing", [{ name: "bash", args: { command: cmd } }]),
    toolResult("bash", out),
  ];
  const before = ran("git status", "nothing to commit");
  const after = [...before, ...ran(`git commit -m "fix the parser"`, "[main abc1234] fix the parser")];
  assert.notEqual(progressKey(after), progressKey(before));
});

test("the same error hit again is not progress", () => {
  // Otherwise a worker stuck rerunning one failing test resets the counter every review.
  const failed = [toolResult("bash", "3 failed\nexited with code 1")];
  assert.equal(progressKey([...failed, ...failed]), progressKey(failed));
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

test("a turn the compaction summary already covers is not sent twice", () => {
  // getBranch keeps the entries a compaction replaced, so passing all of them alongside the
  // summary spends the byte budget on two copies of the same work.
  const view = buildView({
    goal: "g",
    status: "idle",
    entries: [
      assistant("COVERED BY THE SUMMARY", [{ name: "edit", args: { path: "old.ts" } }]),
      { type: "compaction", summary: "[Session Goal]\n- build the dataset" },
      assistant("after the compaction"),
    ],
  });
  assert.match(view, /build the dataset/);
  assert.match(view, /after the compaction/);
  assert.doesNotMatch(view, /COVERED BY THE SUMMARY/);
});

test("pi-vcc's sections and its transcript land on the right sides of the split", () => {
  // compile() emits `sections + "\n\n---\n\n" + transcript`, and drops either part when it is
  // empty. Splitting that wrong put the sections under "Recent turns", where the byte cut eats
  // them from the top.
  const view = buildView({
    goal: "g",
    status: "idle",
    entries: [{ type: "message", message: { role: "user", content: "make the results table" } }],
  });
  const [above, below] = view.split("# Turns so far");
  assert.match(above, /\[Session Goal\]/, "the sections belong above");
  assert.match(below, /make the results table/, "the transcript belongs below");
  assert.doesNotMatch(below, /\[Session Goal\]/);
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
  assert.match(view, /# Goal\nmake the table/);
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
