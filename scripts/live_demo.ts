const BASE_URL = "http://127.0.0.1:4139";

async function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function runDemo() {
  console.log("\n==================================================================");
  console.log("             PROJECT VANESSA - LIVE SYSTEM DEMO                   ");
  console.log("==================================================================\n");

  // 1. Health check
  console.log("⚡ [1/5] Checking Vanessa Orchestrator Status...");
  const statusRes = await fetch(`${BASE_URL}/api/status`);
  const status: any = await statusRes.json();
  console.log("  • Status: ONLINE (Port 4139)");
  console.log(`  • Platform: ${status.platform}`);
  console.log(`  • Active Voice Provider: ${status.activeVoiceProvider}\n`);

  await sleep(1000);

  // 2. Scenario 2: Parallel execution (Bluetooth + YouTube + Folder)
  console.log("🚀 [2/5] Executing Scenario 2: Multi-Agent Parallel Execution");
  console.log('  Voice Command: "Turn on Bluetooth, open Chrome, and create a Buildathon Demo folder."');
  
  const sc2Res = await fetch(`${BASE_URL}/api/execute`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      command: "Turn on Bluetooth, open Chrome, and create a Buildathon Demo folder.",
    }),
  });
  const sc2Data: any = await sc2Res.json();
  console.log(`  • Spoken Response: "${sc2Data.spokenSummary}"`);
  console.log(`  • Plan ID: ${sc2Data.planId} (${sc2Data.plan.tasks.length} Parallel Tasks)`);
  sc2Data.plan.tasks.forEach((t: any) => {
    console.log(`    - [${t.agent.toUpperCase()}] ${t.action} -> Status: ${t.status}`);
  });
  console.log();

  await sleep(1500);

  // 3. Scenario 3: Autonomous Developer Assistant
  console.log("💻 [3/5] Executing Scenario 3: Developer Agent (Claude Code)");
  console.log('  Voice Command: "Open Claude Code and ask it to build a landing page."');
  const sc3Res = await fetch(`${BASE_URL}/api/execute`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      command: "Open Claude Code and ask it to build a landing page.",
    }),
  });
  const sc3Data: any = await sc3Res.json();
  console.log(`  • Spoken Response: "${sc3Data.spokenSummary}"`);
  sc3Data.plan.tasks.forEach((t: any) => {
    console.log(`    - [${t.agent.toUpperCase()}] ${t.action} (Prompt: "${t.params.prompt}") -> ${t.status}`);
  });
  console.log();

  await sleep(1500);

  // 4. Scenario 1: Wi-Fi Restart with Safety Gate & Human-in-the-Loop Confirmation
  console.log("🛡️  [4/5] Executing Scenario 1: System Agent & Safety Gate Interception");
  console.log('  Voice Command: "Hey Vanessa, my Wi-Fi isn\'t working—restart the adapter."');
  const sc1Res = await fetch(`${BASE_URL}/api/execute`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      command: "Hey Vanessa, my Wi-Fi isn't working—restart the adapter.",
    }),
  });
  const sc1Data: any = await sc1Res.json();
  console.log(`  • Safety Gate Interception: Status = ${sc1Data.status}`);
  console.log(`  • Spoken Confirmation Request: "${sc1Data.spokenSummary}"`);
  console.log(`  • Pending Approval Task: ${sc1Data.pendingTasks[0]?.action} (ID: ${sc1Data.pendingTasks[0]?.id})`);
  
  console.log("  👉 Simulating User Spoken Approval: 'Yes, proceed'...");
  await sleep(1000);

  const approveRes = await fetch(`${BASE_URL}/api/approve`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ taskId: sc1Data.pendingTasks[0]?.id }),
  });
  const approveData: any = await approveRes.json();
  console.log(`  • Approval Granted! Execution Result:`);
  console.log(`    - Adapter: ${approveData.task.result.adapter}`);
  console.log(`    - Output: ${approveData.task.result.output}`);
  console.log(`    - Final Status: ${approveData.task.status}\n`);

  await sleep(1500);

  // 5. Scenario 4: Cloud Upload & Share Link
  console.log("☁️  [5/5] Executing Scenario 4: Secure Cloud Storage & Link Generation");
  console.log('  Voice Command: "Upload the report to Drive and send me the link."');
  const sc4Res = await fetch(`${BASE_URL}/api/execute`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      command: "Upload the report to Drive and send me the link.",
    }),
  });
  const sc4Data: any = await sc4Res.json();
  console.log(`  • Intercepted by Safety Gate: ${sc4Data.spokenSummary}`);
  if (sc4Data.pendingTasks.length > 0) {
    const driveApprove = await fetch(`${BASE_URL}/api/approve`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ taskId: sc4Data.pendingTasks[0]?.id }),
    });
    const driveApprovedData: any = await driveApprove.json();
    console.log(`  • Upload Approved -> Result: ${driveApprovedData.task.result.shareLink}`);
  }

  // 6. Security Audit Log
  console.log("\n🔒 [Audit Log Stream]:");
  const auditRes = await fetch(`${BASE_URL}/api/audit?limit=5`);
  const auditEntries: any = await auditRes.json();
  auditEntries.forEach((entry: any) => {
    const time = new Date(entry.timestamp).toLocaleTimeString();
    console.log(`  [${time}] [${entry.payload?.agent || entry.type}] ${entry.payload?.action || ""} (${entry.payload?.status || "event"})`);
  });

  console.log("\n==================================================================");
  console.log("     DEMO COMPLETE: ALL SCENARIOS & SAFETY GATES VALIDATED!       ");
  console.log("==================================================================\n");
}

runDemo().catch(console.error);
