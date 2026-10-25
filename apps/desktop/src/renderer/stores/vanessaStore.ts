import { create } from "zustand";
import { Plan, Task, AuditEntry } from "@vanessa/shared";

export type VoiceState = "idle" | "listening" | "thinking" | "executing" | "speaking" | "responding" | "interrupted" | "error";

interface VanessaState {
  voiceState: VoiceState;
  activePlan: Plan | null;
  tasks: Task[];
  pendingApproval: Task | null;
  auditLogs: AuditEntry[];
  transcript: string;
  lastResponse: string;
  voiceProvider: "elevenlabs" | "fish" | "mock";

  // Actions
  setVoiceState: (state: VoiceState) => void;
  setActivePlan: (plan: Plan | null) => void;
  updateTask: (task: Task) => void;
  setPendingApproval: (task: Task | null) => void;
  addAuditLog: (entry: AuditEntry) => void;
  setTranscript: (text: string) => void;
  setLastResponse: (text: string) => void;
  setVoiceProvider: (provider: "elevenlabs" | "fish" | "mock") => void;
}

export const useVanessaStore = create<VanessaState>((set) => ({
  voiceState: "idle",
  activePlan: null,
  tasks: [],
  pendingApproval: null,
  auditLogs: [],
  transcript: "",
  lastResponse: "Vanessa online. What should I do?",
  voiceProvider: "elevenlabs",

  setVoiceState: (voiceState) => set({ voiceState }),
  setActivePlan: (activePlan) => set({ activePlan, tasks: activePlan ? activePlan.tasks : [] }),
  updateTask: (updatedTask) =>
    set((state) => {
      const index = state.tasks.findIndex((t) => t.id === updatedTask.id);
      let newTasks: Task[];
      if (index >= 0) {
        newTasks = [...state.tasks];
        newTasks[index] = updatedTask;
      } else {
        newTasks = [...state.tasks, updatedTask];
      }

      // Check if it's currently awaiting approval
      const pendingApproval = updatedTask.status === "awaiting_approval" ? updatedTask : state.pendingApproval?.id === updatedTask.id ? null : state.pendingApproval;

      return { tasks: newTasks, pendingApproval };
    }),
  setPendingApproval: (pendingApproval) => set({ pendingApproval }),
  addAuditLog: (entry) =>
    set((state) => ({
      auditLogs: [entry, ...state.auditLogs].slice(0, 100),
    })),
  setTranscript: (transcript) => set({ transcript }),
  setLastResponse: (lastResponse) => set({ lastResponse }),
  setVoiceProvider: (voiceProvider) => set({ voiceProvider }),
}));
