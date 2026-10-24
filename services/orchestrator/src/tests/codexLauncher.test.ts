import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { codexDependencies, openCodex } from "../agents/codex-launcher.js";
import { developerAgent } from "../agents/developer.agent.js";

function fixture() {
  const calls: { script?: string; env?: Record<string, string>; args?: string[] } = {};
  const deps = {
    ...codexDependencies,
    platform: () => "win32",
    stat: (async (path: string) => ({
      isDirectory: () => !path.endsWith("not-a-directory"),
      isFile: () => /codex\.cmd$|codex\.js$|codex-terminal\.cjs$/.test(path),
    })) as typeof codexDependencies.stat,
    run: async (_file: string, args: string[]) => {
      calls.args = args;
      return { stdout: "Usage: codex [OPTIONS] [PROMPT]", stderr: "" };
    },
    terminal: (async (script: string, env: Record<string, string>) => {
      calls.script = script;
      calls.env = env;
      return { stdout: "1234\r\n", stderr: "" };
    }) as typeof codexDependencies.terminal,
  };
  return { deps, calls };
}

test("rejects invalid inputs before inspecting or launching Codex", async () => {
  for (const params of [ {}, { projectPath: ".", prompt: " \n" },
    { projectPath: 42, prompt: "hello" }, { projectPath: "not-a-directory", prompt: "hello" },
    { projectPath: ".", prompt: "a\0b" }]) {
    const { deps, calls } = fixture();
    assert.equal((await openCodex(params, deps)).success, false);
    assert.equal(calls.args, undefined);
    assert.equal(calls.env, undefined);
  }
  assert.equal((await developerAgent.execute("codex.open", {})).success, false);
});

test("reports missing CLI, unsupported help, and launch errors", async () => {
  const params = { projectPath: ".", prompt: "hello" };
  const missing = fixture();
  missing.deps.stat = (async () => ({ isDirectory: () => true, isFile: () => false })) as typeof codexDependencies.stat;
  assert.match((await openCodex(params, missing.deps)).error!, /not found on PATH/);
  const old = fixture();
  old.deps.run = async () => ({ stdout: "Unknown CLI", stderr: "" });
  assert.match((await openCodex(params, old.deps)).error!, /does not advertise/);
  assert.equal(old.calls.env, undefined);
  const failure = fixture();
  failure.deps.terminal = async () => { throw new Error("access denied"); };
  assert.match((await openCodex(params, failure.deps)).error!, /access denied/);
  const helpFailure = fixture();
  helpFailure.deps.run = async () => { throw new Error("CLI broken"); };
  assert.match((await openCodex(params, helpFailure.deps)).error!, /Could not inspect Codex --help/);
  const invalidPath = fixture();
  invalidPath.deps.stat = async () => { throw new Error("ENOENT"); };
  assert.match((await openCodex(params, invalidPath.deps)).error!, /Invalid or inaccessible project directory/);
  const badPid = fixture();
  badPid.deps.terminal = async () => ({ stdout: "", stderr: "" });
  assert.match((await openCodex(params, badPid.deps)).error!, /no process ID/);
});

test("prompt and paths remain data all the way to shell-free spawn", async () => {
  const { deps, calls } = fixture();
  const prompt = '--help "quotes"\n$(whoami); & | < > %PATH% ` \' single';
  const result = await openCodex({ projectPath: "project space & $value", prompt }, deps);
  assert.equal(result.success, true);
  assert.deepEqual(calls.args?.slice(-1), ["--help"]);
  assert.equal(calls.script?.includes(prompt), false);
  assert.equal(calls.script?.includes("project space"), false);
  assert.equal(calls.script?.includes("ExecutionPolicy"), false);
  assert.equal("verification" in result, false);
  const request = JSON.parse(calls.env!.VANESSA_CODEX_REQUEST);
  assert.deepEqual(request.args.slice(-2), ["--", prompt]);
  let spawned = false;
  runInNewContext(readFileSync(new URL("../agents/codex-terminal.cjs", import.meta.url), "utf8"), {
    process: { env: { VANESSA_CODEX_REQUEST: calls.env!.VANESSA_CODEX_REQUEST } }, console,
    require: (name: string) => {
      assert.equal(name, "node:child_process");
      return { spawnSync: (file: string, args: string[], options: Record<string, unknown>) => {
        spawned = true;
        assert.equal(file, request.file);
        assert.deepEqual(Array.from(args), request.args);
        assert.equal(options.cwd, request.projectPath);
        assert.equal(options.shell, false);
        assert.equal(options.stdio, "inherit");
        return { status: 0 };
      } };
    },
  });
  assert.equal(spawned, true);
});
