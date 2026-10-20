import { skillsRuntime } from "../skills/skillsRuntime.js";
import { criticEngine } from "../core/critic.js";
import { planner } from "../core/planner.js";
import { runPlan } from "../core/taskRunner.js";
import { vanessaAgent } from "../agents/openjarvis.agent.js";
import { Task } from "@vanessa/shared";

async function runSkillsTestSuite() {
  console.log("==================================================");
  console.log("      VANESSA SKILLS RUNTIME & CRITIC SUITE       ");
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

  // Test 1: Discover & index all 11 skills
  await assertTest("SkillsRuntime: Discover and index all 11 modular skills from skills/", async () => {
    await skillsRuntime.initialize();
    const skills = skillsRuntime.listSkills();
    const expectedSkills = [
      "app-launcher",
      "drive-upload",
      "email-forward",
      "folder-setup",
      "incident-triage",
      "landing-page-brief",
      "network-troubleshoot",
      "remember-preferences",
      "run-tests-and-explain",
      "web-research",
      "youtube-playback",
    ];
    const allFound = expectedSkills.every((s) => skills.some((sk) => sk.name === s));
    return allFound && skills.length >= 11;
  });

  // Test 2: Invariant and Locks Extraction
  await assertTest("SkillsRuntime: Correctly parse frontmatter locks, jobType, and invariants", async () => {
    const netSkill = skillsRuntime.getSkill("network-troubleshoot");
    const incSkill = skillsRuntime.getSkill("incident-triage");
    const testSkill = skillsRuntime.getSkill("run-tests-and-explain");
    const webSkill = skillsRuntime.getSkill("web-research");

    const netOk = Boolean(netSkill && netSkill.locks?.includes("network-adapter") && netSkill.jobType === "action");
    const incOk = Boolean(incSkill && incSkill.jobType === "goal" && incSkill.invariants?.some((i) => i.includes("deploy")));
    const testOk = Boolean(testSkill && testSkill.jobType === "goal" && testSkill.invariants?.some((i) => i.includes("exitCode")));
    const webOk = Boolean(webSkill && webSkill.jobType === "goal" && webSkill.invariants?.some((i) => i.includes("Prompt Injection")));

    return Boolean(netOk && incOk && testOk && webOk);
  });

  // Test 3: Semantic Skill Matching
  await assertTest("SkillsRuntime: Match natural language commands to skills", async () => {
    const s1 = skillsRuntime.matchSkill("Hey Vanessa, research local vector databases");
    const s2 = skillsRuntime.matchSkill("Fix the Wi-Fi adapter connection");
    const s3 = skillsRuntime.matchSkill("Upload this brief to Drive");
    const s4 = skillsRuntime.matchSkill("Play lofi beats on YouTube");
    const s5 = skillsRuntime.matchSkill("Remember that my preferred terminal is PowerShell");

    return Boolean(
      s1?.name === "web-research" &&
      s2?.name === "network-troubleshoot" &&
      s3?.name === "drive-upload" &&
      s4?.name === "youtube-playback" &&
      s5?.name === "remember-preferences"
    );
  });

  // Test 4: Critic Evaluates Invariant Violation (Zero-Deploy Enforced)
  await assertTest("CriticEngine: Flag violation if an agent attempts unauthorized production deploy", async () => {
    const incSkill = skillsRuntime.getSkill("incident-triage");
    const rogueTask: Task = {
      id: "t_rogue",
      agent: "coding",
      action: "deploy --prod",
      params: { env: "production" },
      dependsOn: [],
      status: "success",
      result: { executed: "kubectl apply -f prod" },
    };

    const verdict = criticEngine.evaluate(rogueTask, incSkill);
    return !verdict.passed && verdict.invariantsPreserved === false && verdict.score === 0;
  });

  // Test 5: Critic Evaluates Testing Invariant (exitCode === 0 Required)
  await assertTest("CriticEngine: Require verified exit code 0 for testing skills ('terminal != test')", async () => {
    const testSkill = skillsRuntime.getSkill("run-tests-and-explain");
    const failedTestTask: Task = {
      id: "t_test_fail",
      agent: "testing",
      action: "testing.verify_regression",
      params: {},
      dependsOn: [],
      status: "failed",
      verification: {
        verified: false,
        exitCode: 1,
        postconditions: ["Test failed with assertion error"],
        outcome: "failed",
      },
    };

    const verdict = criticEngine.evaluate(failedTestTask, testSkill);
    return !verdict.passed && verdict.score < 0.5;
  });

  // Test 6: Goal Job ReAct Execution via OpenJarvis Bridge
  await assertTest("OpenJarvis Integration: Execute goal job via ReAct loop and verify structured thoughts/actions", async () => {
    const goalResult = await vanessaAgent.runGoal("Research local AI models for desktop", ["web_search", "shell_exec"], 3);
    const valid =
      goalResult.success === true &&
      goalResult.mode === "openjarvis_react" &&
      Array.isArray(goalResult.steps) &&
      goalResult.steps.length > 0 &&
      Boolean(goalResult.final_answer);

    return valid;
  });

  // Test 7: End-to-End Planner DAG Execution with Skill Enriched Task
  await assertTest("Planner & TaskRunner: End-to-end plan execution with skill enrichment and critic proof", async () => {
    const plan = await planner.createPlan("Research local vector databases for desktop");
    const researchTask = plan.tasks.find((t) => t.skillName === "web-research");
    if (!researchTask) return false;

    const results = await runPlan(plan);
    const completed = results.find((t) => t.id === researchTask.id);

    return Boolean(
      completed &&
      completed.status === "success" &&
      completed.skillName === "web-research" &&
      completed.critic?.passed === true &&
      completed.critic?.proof
    );
  });

  console.log(`\nResults: ${passed}/${total} skills & critic tests passed.`);
  if (passed !== total) {
    process.exit(1);
  }
  process.exit(0);
}

runSkillsTestSuite().catch((err) => {
  console.error("Test runner crashed:", err);
  process.exit(1);
});
