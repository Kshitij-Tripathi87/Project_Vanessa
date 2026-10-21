import { developerAgent } from "../agents/developer.agent.js";

const result = await developerAgent.execute("codex.open", {
  projectPath: process.argv[2] || process.cwd(),
  prompt: process.argv[3] || "Read-only smoke test: report your current working directory. Do not create, modify, or delete any files. Do not run builds, tests, or install commands.",
});
console.log(JSON.stringify(result, null, 2));
if (!result.success) process.exitCode = 1;
