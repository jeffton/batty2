import type { SessionState, UiMessage } from "@/shared/types";

export type OptimisticUserMessage = Extract<UiMessage, { role: "user" }>;
export type PendingOptimisticMessage = {
  message: OptimisticUserMessage;
  clientMessageId: string;
  showInTranscript: boolean;
};

type OptimisticSession = Pick<SessionState, "messages" | "queuedPrompts" | "updatedAt">;

// Both the transcript and inbox acknowledge a submission. Once acknowledged,
// the server owns its lifecycle, including withdrawal from another tab.
export function reconcileOptimisticMessages(
  pending: PendingOptimisticMessage[],
  session: OptimisticSession,
): PendingOptimisticMessage[] {
  const acknowledged = new Set([
    ...session.messages.flatMap((message) =>
      message.role === "user" && message.clientMessageId ? [message.clientMessageId] : [],
    ),
    ...(session.queuedPrompts ?? []).flatMap((prompt) =>
      prompt.clientMessageId ? [prompt.clientMessageId] : [],
    ),
  ]);
  return pending.filter((item) => !acknowledged.has(item.clientMessageId));
}

// The inbox owns queued submissions. Only genuine sends belong in the transcript.
export function optimisticTranscriptMessages(
  pending: PendingOptimisticMessage[],
  session: OptimisticSession,
): OptimisticUserMessage[] {
  return reconcileOptimisticMessages(pending, session)
    .filter((item) => item.showInTranscript)
    .map((item) => item.message);
}
