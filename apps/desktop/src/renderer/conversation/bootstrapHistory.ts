import type { PersistedConversationState } from "@vanessa/protocol/conversation";
import type { LocalConversationHistory } from "./localConversationHistory.js";

/** No conversation runtime or command control exists until the bounded load ends. */
export async function hydrateBeforeStartingConversation(
  history: Pick<LocalConversationHistory, "initialize">,
  publish: (state: PersistedConversationState) => void,
  start: () => void,
  onError: () => void,
): Promise<void> {
  try {
    const state = await history.initialize();
    if (state) publish(state);
  } catch {
    onError();
  } finally {
    start();
  }
}
