import assert from "node:assert/strict";
import { WindowsAgent } from "../agents/windows.agent.js";

async function main() {
  const previousFake = process.env.FAKE;
  process.env.FAKE = "1";
  const agent = new WindowsAgent();
  const cases: Array<{ name: string; run: () => Promise<void> }> = [
    {
      name: "fake brightness change is partial and never claims live hardware success",
      run: async () => {
        const result = await agent.execute("brightness.set", { level: 80 });
        assert.equal(result.status, "partial");
        assert.equal(result.success, false);
        assert.equal((result.data as any).simulated, true);
        assert.equal((result.data as any).observedBrightness, 80);
        assert.equal(result.verification?.passed, false);
        assert.match(result.summary || "", /SIMULATED ONLY/i);
        assert.match(result.spokenSummary || "", /simulation/i);
        assert.doesNotMatch(result.spokenSummary || "", /brightness is 80 percent/i);
      },
    },
    {
      name: "out-of-range brightness is rejected rather than clamped",
      run: async () => {
        const result = await agent.execute("brightness.set", { level: 120 });
        assert.equal(result.status, "failed");
        assert.equal(result.success, false);
        assert.match(result.summary || "", /integer from 0 to 100/i);
        assert.equal(result.verification?.passed, false);
      },
    },
    {
      name: "fractional brightness adjustment is rejected",
      run: async () => {
        const result = await agent.execute("brightness.adjust", { delta: 10.5 });
        assert.equal(result.status, "failed");
        assert.equal(result.success, false);
        assert.match(result.summary || "", /integer from -100 to 100/i);
      },
    },
    {
      name: "simulated Bluetooth state is partial and expressly simulation-only",
      run: async () => {
        const result = await agent.execute("bluetooth.disable", {});
        assert.equal(result.status, "partial");
        assert.equal(result.success, false);
        assert.equal(result.verification?.passed, false);
        assert.match(result.summary || "", /SIMULATED ONLY/i);
        assert.match(result.spokenSummary || "", /did not change/i);
      },
    },
  ];
  let failures = 0;
  try {
    for (const test of cases) {
      try { await test.run(); console.log("PASS " + test.name); }
      catch (error) { failures++; console.error("FAIL " + test.name + ": " + (error instanceof Error ? error.stack || error.message : String(error))); }
    }
  } finally {
    if (previousFake === undefined) delete process.env.FAKE; else process.env.FAKE = previousFake;
  }
  console.log("Windows agent safety tests: " + (cases.length - failures) + "/" + cases.length + " passed");
  process.exit(failures ? 1 : 0);
}
void main().catch((error) => { console.error(error); process.exit(1); });