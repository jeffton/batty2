export function subagentSessionId(
  resultId: unknown,
  argumentsValue: Record<string, unknown>,
): string | undefined {
  if (typeof resultId === "string" && resultId.trim()) {
    return resultId;
  }
  const argumentId = argumentsValue.sessionId;
  return typeof argumentId === "string" && argumentId.trim() ? argumentId : undefined;
}
