export type ConversationRole = "assistant" | "worker" | "cron";

/** One permanent assistant owns OptChat; workers retain native compaction.
 * Roy workers may navigate the assistant archive, other workspaces stay isolated.
 */
export function conversationPolicy(role: ConversationRole, workspaceId?: string) {
  return {
    role,
    nativeCompaction: role !== "assistant",
    mainMemory: role === "assistant" || workspaceId === "roy",
  };
}
