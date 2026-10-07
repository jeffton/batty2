import type { SessionState } from "@/shared/types";
import { RECENT_SESSION_MESSAGE_WINDOW } from "@/shared/session-history";

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
/** Automatic live history stays bounded by time; older pages remain available on demand. */
export function recentSessionWindow(
  session: SessionState | undefined,
  now = Date.now(),
): SessionState | undefined {
  if (!session) return session;
  const maximumStart = Math.max(0, session.messages.length - RECENT_SESSION_MESSAGE_WINDOW);
  let start = 0;
  while (start < maximumStart && session.messages[start]!.timestamp < now - WEEK_MS) start++;
  if (!start) return session;
  return { ...session, messages: session.messages.slice(start), hasMoreMessages: true };
}
