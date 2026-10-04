import type { SessionState, UiMessage } from "@/shared/types";

export type OptimisticUserMessage = Extract<UiMessage, { role: "user" }>;
export type PendingOptimisticMessage = {
  message: OptimisticUserMessage;
  clientMessageId: string;
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

// Queued messages survive refresh without persisting pre-upload display text or
// pretending attachment filenames are recoverable File objects.
export function optimisticTranscriptMessages(
  pending: PendingOptimisticMessage[],
  session: OptimisticSession,
): OptimisticUserMessage[] {
  const confirmed = new Set(
    session.messages.flatMap((message) =>
      message.role === "user" && message.clientMessageId ? [message.clientMessageId] : [],
    ),
  );
  const queued = (session.queuedPrompts ?? [])
    .filter((prompt) => !prompt.clientMessageId || !confirmed.has(prompt.clientMessageId))
    .map((prompt): OptimisticUserMessage => ({
      id: `queued-user-${prompt.index}`,
      role: "user",
      timestamp: session.updatedAt,
      clientMessageId: prompt.clientMessageId,
      blocks: [{ type: "text", text: prompt.text }],
    }));
  return [...queued, ...reconcileOptimisticMessages(pending, session).map((item) => item.message)];
}
