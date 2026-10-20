import type { Plan, Task } from "@vanessa/shared";

export type WorkingMemorySnapshot = {
  activePlanId?: string;
  command?: string;
  taskResults: Record<string, unknown>;
  agentNotes: Record<string, string>;
};

export class WorkingMemory {
  private snapshot: WorkingMemorySnapshot = {
    taskResults: {},
    agentNotes: {},
  };

  setActivePlan(plan: Plan) {
    this.snapshot = {
      activePlanId: plan.id,
      command: plan.command,
      taskResults: {},
      agentNotes: {},
    };
  }

  recordTaskResult(task: Task) {
    this.snapshot.taskResults[task.id] = task.result;
    if (task.spokenSummary) {
      this.snapshot.agentNotes[task.agent] = task.spokenSummary;
    }
  }

  writeAgentNote(agent: string, note: string) {
    this.snapshot.agentNotes[agent] = note;
  }

  readTaskResult(taskId: string) {
    return this.snapshot.taskResults[taskId];
  }

  getSnapshot(): WorkingMemorySnapshot {
    return {
      activePlanId: this.snapshot.activePlanId,
      command: this.snapshot.command,
      taskResults: { ...this.snapshot.taskResults },
      agentNotes: { ...this.snapshot.agentNotes },
    };
  }

  clear() {
    this.snapshot = {
      taskResults: {},
      agentNotes: {},
    };
  }
}

export const workingMemory = new WorkingMemory();
