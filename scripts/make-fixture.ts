/**
 * Generate test/forked-session.jsonl: a pi session tree with one abandoned branch.
 *
 * Synthetic on purpose. An earlier version of this fixture was a verbatim copy of a real user
 * session, which must not go into a git repo. The test only needs the tree shape.
 */
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";

const TURNS = 188; // 2 entries per turn, plus the header and the abandoned branch
const ABANDONED = 11; // turns on the branch that was rewound away

const lines: string[] = [];
let n = 0;
const id = () => `e${String(n++).padStart(4, "0")}`;
const stamp = (i: number) => new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString();

lines.push(JSON.stringify({ type: "session", version: 3, id: "fixture", timestamp: stamp(0), cwd: "/tmp/fixture" }));

let parent: string | null = null;
function message(role: string, text: string, at: number) {
  const entry = {
    type: "message",
    id: id(),
    parentId: parent,
    timestamp: stamp(at),
    message: { role, content: [{ type: "text", text }] },
  };
  lines.push(JSON.stringify(entry));
  parent = entry.id;
  return entry.id;
}

// A few turns, then a fork point.
for (let i = 0; i < 6; i++) {
  message("user", `shared turn ${i}, this text is on every branch`, i * 2);
  message("assistant", `shared reply ${i}, this text is on every branch`, i * 2 + 1);
}
const forkPoint = parent;

// The branch that was rewound away. Its text must never reach the supervisor.
for (let i = 0; i < ABANDONED; i++) {
  message("user", `ABANDONED turn ${i}, rewound away and must not appear in a view`, 100 + i * 2);
  message("assistant", `ABANDONED reply ${i}, rewound away and must not appear in a view`, 100 + i * 2 + 1);
}

// The live branch continues from the fork point.
parent = forkPoint;
for (let i = 0; i < TURNS; i++) {
  message("user", `live turn ${i}, this is the branch the supervisor should read`, 300 + i * 2);
  message("assistant", `live reply ${i}, this is the branch the supervisor should read`, 300 + i * 2 + 1);
}

const out = resolve(import.meta.dirname, "../test/forked-session.jsonl");
writeFileSync(out, `${lines.join("\n")}\n`);
console.log(`wrote ${out}`);
console.log(`entries (excluding the session header): ${n}`);
console.log(`abandoned entries: ${ABANDONED * 2}`);
