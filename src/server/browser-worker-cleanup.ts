import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import {
  InboxDoc,
  LiveDoc,
  type ConversationId,
  type Cursor,
  type Harness,
} from "@earendil-works/pi-durable";
import type { BrowserService } from "./browser-service";
import { OrchestrationDoc, WorkerDoc } from "./orchestration";
import { ArchivedWorker } from "./orchestration-history";

export const WORKER_BROWSER_RETENTION_MS = 30 * 60_000;

/** Keep resumable worker tabs briefly; durable interruption and main browsers do not expire. */
export function createWorkerBrowserCleanup(
  browser: Pick<BrowserService, "hasSession" | "expireWorkerSession">,
) {
  let unsubscribe: (() => void) | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;
  const candidates = new Set<ConversationId>();
  const pending = new Set<Promise<void>>();

  async function cleanup(
    harness: Harness,
    id: ConversationId,
    finishedAt?: number,
    stoppedTask?: string,
  ) {
    await browser.expireWorkerSession(
      String(id),
      async () => {
        const metadata = await harness.snapshot(WorkerDoc, id, context);
        const state = await harness.snapshot(OrchestrationDoc, context);
        if (id === state?.mainId || (!metadata?.isSubagent && !metadata?.isCron)) return;
        const worker =
          state?.workers[String(id)] ??
          (await harness.snapshot(ArchivedWorker, String(id), context));
        if (worker?.active === undefined) return;
        if (stoppedTask !== undefined && String(worker.active) !== stoppedTask) return;
        const task = await harness.getTask(worker.active, context);
        if (task?.state.status !== "terminal") return;
        for (const call of Object.values(state?.calls ?? {})) {
          if (
            call.workerId === String(id) &&
            (await harness.getTask(call.taskId, context))?.state.status !== "terminal"
          )
            return;
        }
        const live = await harness.snapshot(LiveDoc, id, context);
        const inbox = await harness.snapshot(InboxDoc, id, context);
        if (live?.run || inbox?.items.length) return;
        // Legacy browsers have no idle receipt. Their final conversation entry
        // gives the last activity time; never substitute the worker's launch time.
        const latest = await harness.commit(
          (tx) => tx.scanEntries({ conversationId: id }, 1),
          context,
        );
        const timestamps = latest.items[0]?.model?.map((message) => message.timestamp) ?? [];
        const since = finishedAt ?? Math.max(...timestamps);
        if (!Number.isFinite(since)) return;
        return {
          taskId: String(task.id),
          since,
          stopped: stoppedTask !== undefined || task.state.outcome.status === "aborted",
        };
      },
      WORKER_BROWSER_RETENTION_MS,
    );
    if (!(await browser.hasSession(String(id)))) candidates.delete(id);
  }

  function schedule(harness: Harness, id: ConversationId, finishedAt?: number) {
    candidates.add(id);
    // Commit observers cannot call harness APIs on the committing stack.
    const work = Promise.resolve().then(() => cleanup(harness, id, finishedAt));
    pending.add(work);
    work.then(
      () => pending.delete(work),
      (error) => {
        pending.delete(work);
        console.error("Worker browser cleanup", error);
      },
    );
  }

  return {
    async stop(harness: Harness, id: ConversationId, taskId: string) {
      await cleanup(harness, id, Date.now(), taskId);
    },
    async bind(harness: Harness) {
      unsubscribe?.();
      unsubscribe = harness.subscribeCommits((publication) => {
        for (const change of publication.changes) {
          if (
            change.type !== "task" ||
            change.value.kind !== "batty.delivery" ||
            change.value.state.status !== "terminal"
          )
            continue;
          const input = change.value.input as { childId: number; inline?: boolean };
          if (!input.inline) schedule(harness, input.childId as ConversationId, Date.now());
        }
      });
      // Browser directories are hashed conversation IDs; enumerate owners, not processes.
      // Before resume, recover expiry interrupted after a terminal commit.
      let cursor: Cursor | undefined;
      do {
        const page = await harness.commit((tx) => tx.scanConversations({}, 200, cursor), context);
        for (const conversation of page.items) {
          if (!(await browser.hasSession(String(conversation.id)))) continue;
          candidates.add(conversation.id);
          await cleanup(harness, conversation.id);
        }
        cursor = page.next;
      } while (cursor);
      timer = setInterval(() => {
        for (const id of candidates) schedule(harness, id);
      }, 60_000);
      timer.unref();
    },
    async close() {
      unsubscribe?.();
      unsubscribe = undefined;
      if (timer) clearInterval(timer);
      await Promise.allSettled(pending);
    },
  };
}
