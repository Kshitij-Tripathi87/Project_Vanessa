import { memoryAgent } from "./memory.agent.js";
import { codingAgent } from "./coding.agent.js";
import { itOpsAgent } from "./it_ops.agent.js";
import { knowledgeAgent } from "./knowledge.agent.js";
import { testingAgent } from "./testing.agent.js";
import { windowsAgent } from "./windows.agent.js";
import { browserAgent } from "./browser.agent.js";
import { fileAgent } from "./file.agent.js";
import { folderAgent } from "./folder.agent.js";
import { developerAgent } from "./developer.agent.js";
import { cloudAgent } from "./cloud.agent.js";
import { vanessaAgent, openJarvisAgent, toolsAgent, connectorAgent } from "./openjarvis.agent.js";
import { incidentAgent } from "./incident.agent.js";
import { SpecialistAgent } from "@vanessa/shared";

export const agentRegistry: Record<string, SpecialistAgent | any> = {
  // First-Class Specialist Agents
  memory: memoryAgent,
  coding: codingAgent,
  it_ops: itOpsAgent,
  knowledge: knowledgeAgent,
  testing: testingAgent,
  windows: windowsAgent,
  browser: browserAgent,
  files: fileAgent,
  folder: folderAgent,

  // Compatibility & Integration Agents
  system: windowsAgent,
  developer: developerAgent,
  cloud: cloudAgent,
  vanessa: vanessaAgent,
  jarvis: vanessaAgent,
  openjarvis: openJarvisAgent,
  tools: toolsAgent,
  connector: connectorAgent,
  incident: incidentAgent,
};

export function getAgent(name: string) {
  const agent = agentRegistry[name];
  if (!agent) {
    throw new Error(`Unknown agent: ${name}`);
  }
  return agent;
}

export function listSpecialistAgents(): { id: string; capabilities: string[]; allowedTools: string[] }[] {
  const specialists = [memoryAgent, codingAgent, itOpsAgent, knowledgeAgent, testingAgent, windowsAgent, browserAgent, fileAgent, folderAgent];
  return specialists.map((s) => ({
    id: s.id,
    capabilities: s.capabilities,
    allowedTools: s.allowedTools,
  }));
}
