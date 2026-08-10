/** Show which supervisor policy file would be used, and its first lines. */
import { loadSupervisorPrompt } from "../src/prompts.ts";

const { prompt, source } = loadSupervisorPrompt(process.argv[2] ?? process.cwd());
console.log(`PI_CODING_AGENT_DIR: ${process.env.PI_CODING_AGENT_DIR ?? "(unset, defaults to ~/.pi/agent)"}`);
console.log(`source             : ${source}`);
console.log(`bytes              : ${Buffer.byteLength(prompt)}`);
console.log("--- first 6 lines ---");
console.log(prompt.split("\n").slice(0, 6).join("\n"));
