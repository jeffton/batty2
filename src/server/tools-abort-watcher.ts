import type { Harness } from "@earendil-works/pi-durable";
import { cancelPersistentBashJob } from "./durable-bash-cancel";

/** Only explicit durable abort receipts stop detached shells; shutdown leaves no such receipt. */
export function createBashAbortWatcher(jobsDir: string) {
  let unsubscribe: (() => void) | undefined;
  const pending = new Set<Promise<void>>();
  const errors: unknown[] = [];
  return {
    bind(harness: Harness) {
      unsubscribe?.();
      unsubscribe = harness.subscribeCommits((publication) => {
        for (const change of publication.changes) {
          if (change.type !== "entry") continue;
          const entry = change.value;
          if (entry.kind !== "pi.tool-result" || entry.byTaskId === undefined) continue;
          const message = entry.model?.find(
            (message) => message.role === "toolResult" && message.toolName === "bash",
          );
          const diagnostics =
            entry.data && typeof entry.data === "object" && !Array.isArray(entry.data)
              ? entry.data.diagnostics
              : undefined;
          if (
            message?.role !== "toolResult" ||
            !Array.isArray(diagnostics) ||
            !diagnostics.some(
              (diagnostic) =>
                diagnostic &&
                typeof diagnostic === "object" &&
                !Array.isArray(diagnostic) &&
                diagnostic.code === "aborted",
            )
          )
            continue;
          const identity = `${entry.conversationId}-${entry.byTaskId}-${message.toolCallId}`;
          const work = new Promise<void>((resolve, reject) => {
            queueMicrotask(() => {
              cancelPersistentBashJob(jobsDir, identity).then(resolve, reject);
            });
          });
          pending.add(work);
          work.then(
            () => pending.delete(work),
            (error) => {
              errors.push(error);
              pending.delete(work);
            },
          );
        }
      });
    },
    async close() {
      unsubscribe?.();
      unsubscribe = undefined;
      await Promise.allSettled(pending);
      if (errors.length) throw new AggregateError(errors, "Failed to stop aborted bash jobs");
    },
  };
}
