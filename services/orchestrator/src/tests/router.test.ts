import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import { test } from "node:test";

process.env.VANESSA_SKIP_DOTENV = "true";
const { ModelRouter } = await import("../core/router.js");

async function fixture(t: any) {
  const keys = ["PLANNER_PROVIDER", "SARVAM_CHAT_PROVIDER", "NVIDIA_API_KEY", "NVIDIA_BASE_URL", "NVIDIA_MODEL", "NVIDIA_TIMEOUT_MS", "SARVAM_API_KEY", "SARVAM_CHAT_URL", "SARVAM_CHAT_MODEL", "SARVAM_CHAT_PLANNER_MAX_OUTPUT_TOKENS", "SARVAM_CHAT_CONVERSATION_MAX_OUTPUT_TOKENS", "VOICE_BUDGET_CAP_INR", "VOICE_BUDGET_PER_USER_CAP_INR"];
  const before = new Map(keys.map(key => [key, process.env[key]]));
  const requests: Array<{ provider: string; body: any }> = [];
  let stall = false;
  let arrived: (() => void) | undefined;
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", chunk => raw += chunk.toString());
    req.on("end", () => {
      const provider = req.url?.startsWith("/nvidia") ? "nvidia" : "sarvam";
      const body = JSON.parse(raw);
      requests.push({ provider, body });
      if (stall) { arrived?.(); return; }
      const text = body.max_tokens === 4096 ? '{"tasks":[{"agent":"windows","action":"wifi.status","params":{}}]}' : "**Hello**\nfrom provider.";
      if (provider === "nvidia") {
        assert.equal(req.headers.authorization, "Bearer router-test-key");
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ choices: [{ finish_reason: "stop", message: { content: text } }] }));
      } else {
        assert.equal(req.headers["api-subscription-key"], "router-test-key");
        assert.equal(body.stream, true);
        res.writeHead(200, { "Content-Type": "text/event-stream" });
        res.write("data: " + JSON.stringify({ choices: [{ delta: { content: text }, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } }) + "\n\n");
        res.end("data: [DONE]\n\n");
      }
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address(); assert(address && typeof address !== "string");
  const url = "http://127.0.0.1:" + address.port;
  Object.assign(process.env, {
    NVIDIA_API_KEY: "router-test-key", NVIDIA_BASE_URL: url + "/nvidia", NVIDIA_MODEL: "nvidia/nemotron-router-test", NVIDIA_TIMEOUT_MS: "1000",
    SARVAM_API_KEY: "router-test-key", SARVAM_CHAT_URL: url + "/sarvam", SARVAM_CHAT_MODEL: "sarvam-router-test",
    SARVAM_CHAT_PLANNER_MAX_OUTPUT_TOKENS: "4096", SARVAM_CHAT_CONVERSATION_MAX_OUTPUT_TOKENS: "256",
    VOICE_BUDGET_CAP_INR: "0", VOICE_BUDGET_PER_USER_CAP_INR: "0",
  });
  const router = new ModelRouter();
  t.after(async () => {
    router.close(); server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    for (const [key,value] of before) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  });
  return { router, requests, stall: () => { stall = true; return new Promise<void>(resolve => arrived = resolve); } };
}

for (const [planner, conversation] of [["nvidia", "sarvam"], ["sarvam", "nvidia"]]) {
  test("routes " + planner + " planning and " + conversation + " conversation independently", { timeout: 5000 }, async t => {
    const f = await fixture(t);
    process.env.PLANNER_PROVIDER = " " + planner.toUpperCase() + " ";
    process.env.SARVAM_CHAT_PROVIDER = conversation;
    assert.equal(f.router.activeProvider, planner);
    assert.equal(f.router.conversationalProvider, conversation);
    assert.equal(f.router.activeModel, planner === "nvidia" ? "nvidia/nemotron-router-test" : "sarvam-router-test");
    const plan = await f.router.callLLM("read status", "planner instructions", "router-plan", new AbortController().signal);
    assert.equal(JSON.parse(plan!).tasks[0].action, "wifi.status");
    assert.equal(await f.router.callConversationalLLM("hello", "history", "router-chat"), "Hello from provider.");
    assert.deepEqual(f.requests.map(r => r.provider), [planner, conversation]);
    assert.deepEqual(f.requests.map(r => r.body.max_tokens), [4096, 256]);
    assert.equal(f.requests[0].body.messages[0].content, "planner instructions");
    assert.match(f.requests[1].body.messages[0].content, /Recent context.*\n.*history/);
    assert(f.router.getUsageSnapshot().events.length > 0, "Sarvam usage accounting remains available");
  });
}

test("provider defaults, legacy Sarvam selector, and explicit invalid provider fail without fallback", { timeout: 5000 }, async t => {
  const f = await fixture(t);
  delete process.env.PLANNER_PROVIDER; delete process.env.SARVAM_CHAT_PROVIDER;
  assert.equal(f.router.activeProvider, "nvidia");
  process.env.SARVAM_CHAT_PROVIDER = "sarvam";
  assert.equal(f.router.activeProvider, "sarvam");
  assert(JSON.parse((await f.router.callLLM("status", "system"))!).tasks);
  process.env.PLANNER_PROVIDER = "gemini";
  await assert.rejects(f.router.callLLM("status", "system"), /Unsupported LLM provider.*gemini/);
  assert.equal(f.requests.length, 1);
});

for (const provider of ["nvidia", "sarvam"]) {
  test(provider + " cancels before send and during an active request", { timeout: 5000 }, async t => {
    const f = await fixture(t);
    process.env.PLANNER_PROVIDER = provider; delete process.env.SARVAM_CHAT_PROVIDER;
    await assert.rejects(f.router.callLLM("status", "system", AbortSignal.abort()));
    assert.equal(f.requests.length, 0);
    const received = f.stall();
    const controller = new AbortController();
    const pending = f.router.callLLM("status", "system", "cancel-" + provider, controller.signal);
    const rejected = assert.rejects(pending, /abort|cancel|timed out/i);
    await received; controller.abort(); await rejected;
    assert.equal(f.requests.length, 1);
  });
}

test("unused malformed NVIDIA configuration does not break Sarvam", { timeout: 5000 }, async t => {
  const f = await fixture(t);
  process.env.PLANNER_PROVIDER = "sarvam"; delete process.env.SARVAM_CHAT_PROVIDER;
  process.env.NVIDIA_BASE_URL = "invalid URL";
  assert(JSON.parse((await f.router.callLLM("status", "system"))!).tasks);
  assert.deepEqual(f.requests.map(r => r.provider), ["sarvam"]);
});
