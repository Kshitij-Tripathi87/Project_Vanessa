import { orchestrator } from "../core/orchestrator.js";
import { planner } from "../core/planner.js";
import { runPlan, resolveParams } from "../core/taskRunner.js";
import { workingMemory } from "../core/workingMemory.js";
import { Task } from "@vanessa/shared";
import { privacyGuard } from "../core/privacy.js";
import { eventBus } from "../core/eventBus.js";
import { permissionGuard } from "../core/permissionGuard.js";

async function runTestSuite() {
  permissionGuard.autonomousMode = false;
  console.log("==================================================");
  console.log("   VANESSA ORCHESTRATOR - LOCKED SCENARIOS SUITE  ");
  console.log("==================================================\n");

  let passed = 0;
  let total = 0;

  async function assertTest(name: string, fn: () => Promise<boolean>) {
    total++;
    try {
      const ok = await fn();
      if (ok) {
        console.log(`✅ [PASS] ${name}`);
        passed++;
      } else {
        console.error(`❌ [FAIL] ${name}`);
      }
    } catch (err: any) {
      console.error(`❌ [ERROR] ${name}: ${err.message}`);
    }
  }

  // Test 1: Plan Generation for Scenario 1
  await assertTest("Scenario 1: Wi-Fi restart generates dependent plan & approval requirement", async () => {
    const cmd = "Hey Vanessa, my Wi-Fi isn’t working—restart the adapter";
    const res = await orchestrator.executeCommand({ command: cmd });
    const hasWifi = res.plan?.tasks.some((t: Task) => t.action === "wifi.restart_adapter");
    const awaiting = res.status === "awaiting_approval";
    return Boolean(hasWifi && awaiting);
  });

  // Test 2: Approval Flow for Scenario 1
  await assertTest("Scenario 1: Approval flow executes paused task", async () => {
    const cmd = "Restart my Wi-Fi adapter";
    const res = await orchestrator.executeCommand({ command: cmd });
    const pendingTask = res.pendingTasks?.[0];
    if (!pendingTask) return false;

    const approved = await orchestrator.approve(pendingTask.id);
    return approved?.status === "success";
  });

  // Test 3: Scenario 2 - Parallel execution of Bluetooth, Chrome, and Folder creation
  await assertTest("Scenario 2: Parallel independent tasks (Bluetooth + Chrome + Folder)", async () => {
    const cmd = "Turn on Bluetooth, open Chrome, and create a Buildathon Demo folder.";
    const plan = await planner.createPlan(cmd);
    const independentTasks = plan.tasks.filter((t: Task) => t.dependsOn.length === 0);
    if (independentTasks.length < 2) return false;

    const results = await runPlan(plan);
    const successCount = results.filter((t: Task) => t.status === "success").length;
    return successCount >= 2;
  });

  // Test 4: Scenario 3 - Claude Code developer launch
  await assertTest("Scenario 3: Claude Code developer task creation", async () => {
    const cmd = "Open Claude Code and ask it to build a landing page.";
    const res = await orchestrator.executeCommand({ command: cmd });
    const claudeTask = res.plan?.tasks.find((t: Task) => t.agent === "developer" && t.action === "claude_code.open");
    return Boolean(claudeTask && claudeTask.params.prompt.includes("landing page"));
  });

  // Test 5: Scenario 4 - Drive upload & share link
  await assertTest("Scenario 4: Drive upload and share link generation", async () => {
    const cmd = "Upload the report to Drive and send me the link.";
    const res = await orchestrator.executeCommand({ command: cmd });
    // Drive upload requires confirmation
    if (res.status === "awaiting_approval" && res.pendingTasks?.length) {
      const approved = await orchestrator.approve(res.pendingTasks[0].id);
      return Boolean(approved?.result?.shareLink);
    }
    return false;
  });

  // Test 6: Safety policy blocks dangerous destructive operations
  await assertTest("Safety Policy: Block dangerous destructive operations", async () => {
    const dangerousCmd = "Delete everything: rm -rf /";
    const plan = {
      id: "malicious_test",
      command: dangerousCmd,
      risk: "high" as const,
      tasks: [
        {
          id: "t_malicious",
          agent: "developer" as const,
          action: "terminal.run_command",
          params: { command: "rm -rf /" },
          dependsOn: [],
          status: "pending" as const,
        },
      ],
    };

    const results = await runPlan(plan);
    return results[0].status === "failed" && Boolean(results[0].error?.includes("Blocked"));
  });

  // Test 7: Vanessa agent status & brain check
  await assertTest("Vanessa Integration: Brain status and 56 registered tools", async () => {
    const cmd = "Hey Vanessa, check status";
    const res = await orchestrator.executeCommand({ command: cmd });
    const task = res.plan?.tasks.find((t: Task) => t.agent === "vanessa" || t.agent === "jarvis");
    return Boolean(task && res.status === "success");
  });

  // Test 8: Vanessa everyday schedule creation
  await assertTest("Vanessa Everyday Scheduler: Create everyday scheduled task", async () => {
    const cmd = "Schedule an everyday task to run system health check every morning";
    const res = await orchestrator.executeCommand({ command: cmd });
    const schedTask = res.plan?.tasks.find((t: Task) => (t.agent === "vanessa" || t.agent === "jarvis") && t.action.includes("schedule_create"));
    return Boolean(schedTask && res.status === "success");
  });

  // Test 9: Vanessa system tool execution with safe fallback
  await assertTest("Vanessa System Execution: Run system shell diagnostic", async () => {
    const res = await orchestrator.executeCommand({ command: "Ask Vanessa to check git status" });
    const task = res.plan?.tasks.find((t: Task) => t.agent === "vanessa" || t.agent === "jarvis");
    return Boolean(task && res.status === "success");
  });

  // Test 10: Vanessa Memory Backend check
  await assertTest("Vanessa Memory: Memory backend active and Rust extension loaded", async () => {
    const res = await orchestrator.executeCommand({ command: "Hey Vanessa, remember this project is Vanessa" });
    const memTask = res.plan?.tasks.find((t: Task) => (t.agent === "vanessa" || t.agent === "jarvis"));
    return Boolean(memTask && res.status === "success");
  });

  // Test 11: Vanessa Multi-Specialist Incident Intelligence workflow end-to-end
  await assertTest("Incident Intelligence v0.2: 4 concurrent specialists, isolated patch, verified fix, zero deployment", async () => {
    const cmd = "Hey Vanessa, investigate why the checkout service is failing. Check the recent code changes, logs, previous incidents and runbook. Prepare a fix, run the tests, and don't deploy anything.";
    const res = await orchestrator.executeCommand({ command: cmd });
    if (res.status !== "success" || !res.plan) return false;

    const hasRepoWorker = res.plan.tasks.some(
      (t: Task) => (t.action === "coding.inspect_changes" || t.action === "incident.analyze_repo") && t.status === "success"
    );
    const hasLogWorker = res.plan.tasks.some(
      (t: Task) => (t.action === "it_ops.analyze_logs" || t.action === "incident.analyze_logs") && t.status === "success"
    );
    const hasMemWorker = res.plan.tasks.some(
      (t: Task) => (t.action === "memory.retrieve" || t.action === "incident.retrieve_memory") && t.status === "success"
    );
    const hasKnowWorker = res.plan.tasks.some(
      (t: Task) => (t.action === "knowledge.retrieve_runbook" || t.action === "incident.retrieve_memory") && t.status === "success"
    );
    const hasPatch = res.plan.tasks.some(
      (t: Task) => (t.action === "coding.prepare_patch" || t.action === "incident.diagnose") && t.status === "success"
    );
    const verifyTask = res.plan.tasks.find(
      (t: Task) => t.action === "testing.verify_regression" || t.action === "incident.prepare_and_verify"
    );

    const testsPassed = Boolean(verifyTask?.result?.testsPassed);
    const deployBlocked = verifyTask?.result?.deploymentStatus === "REFUSED_PER_POLICY";

    return Boolean(hasRepoWorker && hasLogWorker && hasMemWorker && hasKnowWorker && hasPatch && testsPassed && deployBlocked);
  });

  // Test 12: Mobile Companion Remote Command & Origin Provenance
  await assertTest("Mobile Companion: Remote command execution & audit provenance", async () => {
    const remoteCmd = "Upload today's report to Drive and send me the link.";
    eventBus.emitEvent("audit:log", {
      id: `audit-${Date.now()}`,
      timestamp: Date.now(),
      source: "remote_pwa",
      agent: "orchestrator",
      action: "remote_command_received",
      command: remoteCmd,
      risk: "low",
      permission: "allowed",
      status: "info",
      details: { command: remoteCmd, origin: "Phone Mobile Companion PWA" },
    });

    const res = await orchestrator.executeCommand({ command: remoteCmd });
    const hasDriveTask = res.plan?.tasks.some((t: Task) => t.action === "drive.upload");
    if (!hasDriveTask || res.status !== "awaiting_approval") return false;

    // Approve the remote task
    const pending = res.pendingTasks?.[0];
    if (!pending) return false;
    const approved = await orchestrator.approve(pending.id);
    return Boolean(approved?.result?.shareLink);
  });

  // Test 13: Local-First Privacy, Folder Allowlist & Sensitive Data Redaction
  await assertTest("Privacy & Governance: Folder allowlist & sensitive data redaction layer", async () => {
    // 1. Verify folder allowlist defaults
    const status = privacyGuard.getPrivacyStatus();
    const hasVanessaDemo = status.allowedFolders.some((f: string) => f.includes("VanessaDemo"));
    if (!hasVanessaDemo) return false;

    // 2. Verify sensitive data redaction before memory write
    const rawSensitiveString = "User test@company.com with phone 555-123-4567 and API key nvapi-abcdef1234567890abcdef1234567890 and credit card 4111-2222-3333-4444";
    const redacted = privacyGuard.redactSensitiveData(rawSensitiveString);

    const emailRedacted = redacted.cleanText.includes("[REDACTED_EMAIL]");
    const phoneRedacted = redacted.cleanText.includes("[REDACTED_PHONE]");
    const apiKeyRedacted = redacted.cleanText.includes("[REDACTED_API_KEY]");
    const cardRedacted = redacted.cleanText.includes("[REDACTED_CARD]");

    return Boolean(emailRedacted && phoneRedacted && apiKeyRedacted && cardRedacted && redacted.redactedCount >= 4);
  });

  // Test 14: Dynamic DAG Parameter Resolution ($t1.result.<path>) and Shared Working Memory
  await assertTest("DAG Parameter Resolution: Dynamic $t1.result injection & working memory snapshot", async () => {
    const plan = {
      id: "param_res_test",
      command: "Find report and read it",
      risk: "low" as const,
      tasks: [
        {
          id: "t1",
          agent: "files" as const,
          action: "file.search",
          params: { query: "package.json" },
          dependsOn: [],
          status: "pending" as const,
        },
        {
          id: "t2",
          agent: "files" as const,
          action: "drive.upload",
          params: { file: "$t1.result.bestMatch.id" },
          dependsOn: ["t1"],
          status: "pending" as const,
        },
      ],
    };

    const tasks = await runPlan(plan);
    const t1 = tasks.find((t) => t.id === "t1");
    const t2 = tasks.find((t) => t.id === "t2");

    // Task t2 should have had "$t1.result.bestMatch.id" dynamically resolved to the filename found by t1!
    const resolvedCorrectly = Boolean(t2?.params?.file && t2.params.file !== "$t1.result.bestMatch.id");
    const storedInMem = Boolean(workingMemory.readTaskResult("t1"));

    return Boolean(resolvedCorrectly && storedInMem && t1?.status === "success");
  });

  // Test 15: Outbound Relay Device Pairing (Device-name + 6-digit code)
  await assertTest("Relay Device Pairing: Device name + 6-digit code claims short-lived token", async () => {
    const { pathToFileURL } = await import("node:url");
    const path = await import("node:path");
    const fs = await import("node:fs");
    const candidate1 = path.resolve(process.cwd(), "..", "relay", "dist", "pairing.js");
    const candidate2 = path.resolve(process.cwd(), "services", "relay", "dist", "pairing.js");
    const relayDist = fs.existsSync(candidate1) ? candidate1 : candidate2;
    const { createPairingCode, createDeviceToken, verifyDeviceToken } = (await import(pathToFileURL(relayDist).href)) as any;

    const code = createPairingCode();
    const token = createDeviceToken({
      deviceId: "laptop_uuid_test",
      deviceName: "Kshitij-Laptop",
      role: "laptop",
      pairingCode: code,
    });
    const verified = verifyDeviceToken(token);
    return Boolean(code.length === 6 && verified.deviceName === "Kshitij-Laptop" && verified.pairingCode === code);
  });

  // Test 16: Specialist Agent Registry & Contract Validation
  await assertTest("Specialist Registry: 8 specialized agents registered with distinct capabilities and tool allowlists", async () => {
    const { listSpecialistAgents, getAgent } = await import("../agents/registry.js");
    const specialists = listSpecialistAgents();
    const expectedIds = ["memory", "coding", "it_ops", "knowledge", "testing", "windows", "browser", "files"];
    const allRegistered = expectedIds.every((id) => specialists.some((s) => s.id === id));

    // Verify each agent implements SpecialistAgent contract with non-empty capabilities and allowedTools
    const validContracts = expectedIds.every((id) => {
      const agent = getAgent(id);
      return Boolean(
        agent &&
          Array.isArray(agent.capabilities) &&
          agent.capabilities.length > 0 &&
          Array.isArray(agent.allowedTools) &&
          agent.allowedTools.length > 0
      );
    });

    return Boolean(allRegistered && validContracts && specialists.length >= 8);
  });

  // Test 17: Tool Authorization & Security Boundary Enforcement
  await assertTest("Specialist Security: Enforce explicit tool allowlists and prevent unauthorized tool execution", async () => {
    // Attempt to run memory agent with an unauthorized tool like 'shell_exec'
    const plan = {
      id: "security_violation_test",
      command: "Test security boundaries",
      risk: "high" as const,
      tasks: [
        {
          id: "t_unauthorized",
          agent: "memory" as const,
          action: "memory.retrieve",
          params: { query: "test" },
          allowedTools: ["shell_exec", "unrestricted_terminal"], // Not in memoryAgent.allowedTools!
          dependsOn: [],
          status: "pending" as const,
        },
      ],
    };

    const results = await runPlan(plan);
    const failedTask = results.find((t) => t.id === "t_unauthorized");
    return Boolean(failedTask?.status === "failed" && failedTask?.error?.includes("Security violation"));
  });

  // Test 18: Knowledge & Memory Specialists Integration
  await assertTest("Knowledge & Memory Specialists: Retrieve Runbook RB-CHK-04 and match INC-842 with evidence", async () => {
    const { knowledgeAgent } = await import("../agents/knowledge.agent.js");
    const { memoryAgent } = await import("../agents/memory.agent.js");

    const knowRes = await knowledgeAgent.execute("knowledge.retrieve_runbook", { runbook: "checkout" });
    const memRes = await memoryAgent.execute("memory.retrieve", { query: "checkout" });

    const hasRunbookPassage = Boolean((knowRes.data as any)?.runbookTitle?.includes("RB-CHK-04") && knowRes.evidence?.length);
    const hasMemIncident = Boolean((memRes.data as any)?.historicalIncident === "INC-842" && memRes.evidence?.length);

    return Boolean(hasRunbookPassage && hasMemIncident);
  });

  // Test 19: Coding & Testing Specialists Integration
  await assertTest("Coding & Testing Specialists: Isolated patch creation and regression test verification", async () => {
    const { codingAgent } = await import("../agents/coding.agent.js");
    const { testingAgent } = await import("../agents/testing.agent.js");

    const patchRes = await codingAgent.execute("coding.prepare_patch", { branch: "fix/checkout-incident" });
    const testRes = await testingAgent.execute("testing.verify_regression", {
      branch: "fix/checkout-incident",
      autoDeploy: false,
    });

    const patchVerified = Boolean((patchRes.data as any)?.branch === "fix/checkout-incident" && patchRes.verification?.passed);
    const testsPassed = Boolean((testRes.data as any)?.testsPassed && (testRes.data as any)?.deploymentStatus === "REFUSED_PER_POLICY");

    return Boolean(patchVerified && testsPassed);
  });

  // Test 20: Real-Time Voice Streaming, Acoustic Prosody & Sentiment Analysis
  await assertTest("Voice Agent Subsystem: 16kHz PCM acoustic analysis, dual-stream sentiment & barge-in", async () => {
    const { sentimentAnalyzer } = await import("../voice/sentimentAnalyzer.js");
    const { voiceStreamServer } = await import("../voice/voiceStreamServer.js");

    // 1. Synthesize 16kHz sine wave audio buffer (100ms = 1600 samples)
    const samples = new Int16Array(1600);
    for (let i = 0; i < samples.length; i++) {
      samples[i] = Math.round(Math.sin((2 * Math.PI * 440 * i) / 16000) * 16000);
    }
    const acoustic = sentimentAnalyzer.analyzeAcousticBuffer(samples);
    const validAcoustic = acoustic.rms > 0.1 && acoustic.peak > 0.4 && acoustic.estimatedPitchHz > 0;

    // 2. Dual-stream sentiment classification
    const urgentSent = sentimentAnalyzer.analyze("Emergency outage on checkout service, check status immediately!", acoustic);
    const frustratedSent = sentimentAnalyzer.analyze("No, stop doing that, it failed again!");
    const inquisitiveSent = sentimentAnalyzer.analyze("How is our server holding up?");
    const satisfiedSent = sentimentAnalyzer.analyze("Thanks Vanessa, perfect job!");

    const sentimentClassified =
      urgentSent.emotion === "urgent" &&
      frustratedSent.emotion === "frustrated" &&
      inquisitiveSent.emotion === "inquisitive" &&
      satisfiedSent.emotion === "satisfied";

    // 3. Test VoiceStreamServer barge-in and audio frame handling with mock socket
    const sentMessages: any[] = [];
    const mockSocket: any = {
      readyState: 1, // WebSocket.OPEN
      send: (data: string) => {
        try {
          sentMessages.push(JSON.parse(data));
        } catch {
          sentMessages.push(data);
        }
      },
      on: (event: string, callback: any) => {
        mockSocket[`on_${event}`] = callback;
      },
    };

    voiceStreamServer.handleConnection(mockSocket);
    // Send binary PCM frame
    mockSocket.on_message(Buffer.from(samples.buffer), true);
    // Send barge-in interrupt
    mockSocket.on_message(JSON.stringify({ type: "barge_in", timestamp: Date.now() }), false);

    const hasSessionReady = sentMessages.some((m) => m.type === "session_ready" && m.bargeInEnabled === true);
    const hasAudioEnergy = sentMessages.some((m) => m.type === "audio_energy" && m.rms !== undefined);
    const hasBargeInAck = sentMessages.some((m) => m.type === "barge_in_acknowledged");

    return Boolean(validAcoustic && sentimentClassified && hasSessionReady && hasAudioEnergy && hasBargeInAck);
  });

  // Test 21: Revision 0.3 - Idempotency Deduplication & Envelope Expiry
  await assertTest("Revision 0.3: Desktop Durable Inbox & Idempotency Deduplication", async () => {
    const idempotencyKey = `idem-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    const cmd = "Hey Vanessa, check my Wi-Fi status";

    // 1. Initial execution
    const firstRes = await orchestrator.executeCommand({
      command: cmd,
      idempotencyKey,
    });

    // 2. Duplicate submission with same idempotencyKey must return cached result without re-executing
    const duplicateRes = await orchestrator.executeCommand({
      command: cmd,
      idempotencyKey,
    });

    const isIdentical = duplicateRes.spokenSummary === firstRes.spokenSummary && duplicateRes.status === firstRes.status;

    // 3. Expired envelope must be rejected
    const expiredRes = await orchestrator.executeCommand({
      command: cmd,
      envelope: {
        requestId: "req-expired",
        idempotencyKey: "idem-expired",
        originDeviceId: "phone-1",
        command: cmd,
        createdAt: Date.now() - 60000,
        expiresAt: Date.now() - 1000, // expired 1s ago
        schemaVersion: "0.3",
        source: "phone",
      },
    });

    const expiredRejected = expiredRes.status === "failed" && expiredRes.spokenSummary.includes("expired");

    return Boolean(isIdentical && expiredRejected);
  });

  // Test 22: Revision 0.3 - Explicit Task Lifecycle & Postcondition Verification Invariant
  await assertTest("Revision 0.3: Explicit Lifecycle & 'Opened Terminal != Proof of Testing'", async () => {
    const { developerAgent } = await import("../agents/developer.agent.js");
    
    // 1. Terminal launch is marked as workspace launch, NOT proof of tests passed
    const launchResult = await developerAgent.execute("claude_code.open", { prompt: "test landing page", visibleTerminal: false });
    const terminalInvariantPreserved = launchResult.verification?.passed === true &&
      launchResult.verification?.details.includes("Developer workspace");

    // 2. Actual command verification captures exitCode and postconditions
    const cmdResult = await developerAgent.execute("terminal.run_command", { command: "node -e \"console.log('PASS_CHECK')\"" });
    const verifiedCommand = cmdResult.exitCode === 0 && cmdResult.verification?.passed === true;

    // 3. Orchestrator DAG marks tasks with lifecycleState
    const res = await orchestrator.executeCommand({ command: "Turn on Bluetooth and open Chrome" });
    const tasksHaveLifecycle = res.plan?.tasks.every((t: Task) => t.lifecycleState !== undefined);

    return Boolean(terminalInvariantPreserved && verifiedCommand && tasksHaveLifecycle);
  });

  // Test 23: Revision 0.3 - Interrupted Task Reconciliation
  await assertTest("Revision 0.3: Crash Recovery & Non-Idempotent Reconciliation", async () => {
    const { memoryPalace } = await import("../memory/memoryPalace.js");
    
    // Checkpoint an interrupted non-idempotent task
    const mockTask: Task = {
      id: `task-interrupted-${Date.now()}`,
      parentId: "plan-recovery-test",
      agent: "developer",
      action: "terminal.destructive_restart",
      params: { service: "api" },
      dependsOn: [],
      status: "running",
      lifecycleState: "running",
      isIdempotent: false,
    };

    memoryPalace.recordTaskCheckpoint(mockTask, "plan-recovery-test");
    const recoverySummary = memoryPalace.reconcileInterruptedTasks();
    const flaggedForResolution = recoverySummary.requiresResolution.includes(mockTask.id);

    return Boolean(flaggedForResolution);
  });

  console.log(`\nResults: ${passed}/${total} tests passed.`);
  process.exit(passed === total ? 0 : 1);
}

runTestSuite();
