import { withBaseUrl } from "@/client/lib/base-url";
import type { SessionState } from "@/shared/types";
export function sessionEventsPath(
  session: Pick<SessionState, "id">,
  _detail: "summary" | "full" = "full",
): string {
  return withBaseUrl(`/api/sessions/${encodeURIComponent(session.id)}/events`);
}
