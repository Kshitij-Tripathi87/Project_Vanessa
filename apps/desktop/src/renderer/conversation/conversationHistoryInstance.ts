import { useVanessaStore } from "../stores/vanessaStore.js";
import { LocalConversationHistory } from "./localConversationHistory.js";

/** Browser previews deliberately have no OS key provider and remain session-only. */
export const conversationHistory = new LocalConversationHistory(
  () => {
    if (typeof window === "undefined") return undefined;
    const api = window.vanessa;
    if (!api?.loadConversationHistory || !api.saveConversationHistory || !api.clearConversationHistory) return undefined;
    return {
      load: () => api.loadConversationHistory!(),
      save: (state, revision) => api.saveConversationHistory!(state, revision),
      clear: (revision) => api.clearConversationHistory!(revision),
    };
  },
  (status) => useVanessaStore.getState().setConversationHistoryStatus(status),
);
