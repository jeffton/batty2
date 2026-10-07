import type { SessionMessagesPage, SessionState } from "@/shared/types";
import { normalizeSessionState } from "./session-state";

/** A page belongs to the history boundary at which it was requested. */
export function prependHistoryPage(
  current: SessionState,
  requested: SessionState,
  page: SessionMessagesPage,
): SessionState {
  if (
    current.sessionId !== requested.sessionId ||
    current.messages[0]?.id !== requested.messages[0]?.id
  )
    return current;
  const ids = new Set(current.messages.map((message) => message.id));
  const changed =
    current.totalMessageCount !== requested.totalMessageCount ||
    current.hasMoreMessages !== requested.hasMoreMessages;
  return normalizeSessionState({
    ...current,
    messages: [...page.messages.filter((message) => !ids.has(message.id)), ...current.messages],
    totalMessageCount: changed
      ? Math.max(current.totalMessageCount, page.totalMessageCount)
      : page.totalMessageCount,
    hasMoreMessages: changed ? current.hasMoreMessages : page.hasMoreMessages,
  })!;
}
