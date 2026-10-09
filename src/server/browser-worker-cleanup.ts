import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import type { ConversationId, Cursor, Harness } from "@earendil-works/pi-durable";
import type { BrowserService } from "./browser-service";
import { OrchestrationDoc } from "./orchestration";
import { ArchivedWorker } from "./orchestration-history";

export const BROWSER_IDLE_RETENTION_MS = 60 * 60_000;

/** All conversation browsers expire on browser inactivity, including main and interrupted workers. */
export function createWorkerBrowserCleanup(
  browser: Pick<
    BrowserService,
    "hasSession" | "expireIdleSession" | "withSessionLifecycle" | "closeSession"
  >,
) {
  let timer: ReturnType<typeof setInterval> | undefined;
  let pending: Promise<void> | undefined;

  async function sweep(harness: Harness) {
    // Browser directories are hashed conversation IDs; enumerate owners, not processes.
    let cursor: Cursor | undefined;
    do {
      const page = await harness.commit((tx) => tx.scanConversations({}, 200, cursor), context);
      for (const conversation of page.items) {
        if (await browser.hasSession(String(conversation.id)))
          await browser.expireIdleSession(String(conversation.id), BROWSER_IDLE_RETENTION_MS);
      }
      cursor = page.next;
    } while (cursor);
  }

  return {
    async stop(harness: Harness, id: ConversationId, taskId: string) {
      await browser.withSessionLifecycle(String(id), async () => {
        const state = await harness.snapshot(OrchestrationDoc, context);
        const worker =
          state?.workers[String(id)] ??
          (await harness.snapshot(ArchivedWorker, String(id), context));
        // A stop for an old task must not close a browser resumed by a newer task.
        if (String(worker?.active) === taskId) await browser.closeSession(String(id));
      });
    },
    async bind(harness: Harness) {
      if (timer) clearInterval(timer);
      await sweep(harness);
      timer = setInterval(() => {
        if (pending) return;
        pending = sweep(harness)
          .catch((error) => console.error("Browser idle cleanup", error))
          .finally(() => {
            pending = undefined;
          });
      }, 60_000);
      timer.unref();
    },
    async close() {
      if (timer) clearInterval(timer);
      timer = undefined;
      await pending;
    },
  };
}
