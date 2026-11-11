import { readFile, mkdir, writeFile } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const model = process.env.VANESSA_ROUTER_MODEL ?? "lfm3:latest";
const numPredict = Number(process.env.VANESSA_ROUTER_NUM_PREDICT ?? 100);
const think = false;
const api = (process.env.OLLAMA_HOST ?? "http://127.0.0.1:11434").replace(/\/$/, "");
const timestamp = new Date().toISOString().replaceAll(":", "-").replaceAll(".", "-");
const resultDir = resolve(root, "eval/results");
const predictionsPath = resolve(resultDir, `lfm3-ollama-${timestamp}-predictions.jsonl`);
const reportPath = resolve(resultDir, `lfm3-ollama-${timestamp}-report.json`);
const cases = (await readFile(resolve(root, "eval/router-v1.jsonl"), "utf8")).trim().split(/\r?\n/).map((line) => JSON.parse(line));
const tools = JSON.parse(await readFile(resolve(root, "eval/router-tools.v1.json"), "utf8"));
const system = "You are the command router for Vanessa, a PC assistant. Choose exactly one tool for the user's request and fill its arguments from the user's words only. If the request is a question or chat, needs more than one step, needs a tool that is not listed, is risky or bulk (for example deleting many files or changing security settings), or is unclear, output the escalate tool with the closest reason. Never invent file names, apps or values. Omit optional arguments the user did not state. Keep file and app names in the language the user spoke.";

async function chat(utterance) {
  const response = await fetch(`${api}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model, stream: false, think, keep_alive: "30m", messages: [{ role: "system", content: system }, { role: "user", content: utterance }], tools, options: { temperature: 0.1, num_predict: numPredict } }),
    signal: AbortSignal.timeout(120_000),
  });
  if (!response.ok) throw new Error(`Ollama HTTP ${response.status}: ${await response.text()}`);
  return response.json();
}

await mkdir(resultDir, { recursive: true });
const tagsResponse = await fetch(`${api}/api/tags`, { signal: AbortSignal.timeout(5000) });
if (!tagsResponse.ok) throw new Error(`Ollama tags endpoint returned HTTP ${tagsResponse.status}`);
const tags = await tagsResponse.json();
const selected = tags.models?.find((item) => item.name === model || item.model === model);
if (!selected) throw new Error(`Model ${model} is not installed. Pull it with: ollama pull ${model}`);

// Warm model/context once; exclude the warm-up from scored latency.
await chat("Open Chrome.");
const predictions = [];
const responseMetrics = [];
for (const [index, item] of cases.entries()) {
  const started = performance.now();
  const response = await chat(item.utterance);
  const wallMs = Math.round(performance.now() - started);
  const message = response.message ?? {};
  const toolCalls = message.tool_calls ?? [];
  let raw;
  if (toolCalls.length === 1) {
    const call = toolCalls[0];
    const args = call.function?.arguments ?? {};
    raw = JSON.stringify({ t: call.function?.name, a: args });
  } else if (toolCalls.length > 1) raw = JSON.stringify({ t: "invalid_multiple_tool_calls", a: {} });
  else raw = typeof message.content === "string" ? message.content : "";
  predictions.push({ id: item.id, raw, latencyMs: wallMs, confirmationRequired: raw.includes('"t":"delete_file"') });
  responseMetrics.push({ id: item.id, wallMs, totalDurationNs: response.total_duration, promptEvalCount: response.prompt_eval_count, evalCount: response.eval_count, doneReason: response.done_reason, toolCallCount: toolCalls.length });
  console.log(`[${index + 1}/${cases.length}] ${item.id} ${wallMs}ms ${toolCalls.length === 1 ? toolCalls[0].function?.name : "no single tool call"}`);
}

await writeFile(predictionsPath, `${predictions.map((entry) => JSON.stringify(entry)).join("\n")}\n`, "utf8");
const score = spawnSync(process.execPath, ["--experimental-strip-types", resolve(root, "eval/router-eval.ts"), resolve(root, "eval/router-v1.jsonl"), predictionsPath], { cwd: root, encoding: "utf8" });
if (score.error) throw score.error;
if (score.stdout) process.stdout.write(score.stdout);
if (score.stderr) process.stderr.write(score.stderr);
let evaluation;
try { evaluation = JSON.parse(score.stdout); } catch { throw new Error("Could not parse router-eval output; predictions were saved for inspection."); }
const report = {
  model,
  modelDigest: selected.digest,
  modelDetails: selected.details,
  endpoint: api,
  startedAt: timestamp,
  cases: cases.length,
  temperature: 0.1,
  think,
  numPredict,
  toolCount: tools.length,
  toolSchemaPath: "eval/router-tools.v1.json",
  predictionsPath: predictionsPath.replace(`${root}\\`, "").replaceAll("\\", "/"),
  evaluation,
  latency: { p50WallMs: percentile(responseMetrics.map((item) => item.wallMs), 0.5), p95WallMs: percentile(responseMetrics.map((item) => item.wallMs), 0.95), perCase: responseMetrics },
};
await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
console.log(`Saved ${reportPath}`);
if (score.status !== 0) process.exitCode = score.status ?? 1;

function percentile(values, p) { const sorted = [...values].sort((a, b) => a - b); return sorted[Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1)]; }
