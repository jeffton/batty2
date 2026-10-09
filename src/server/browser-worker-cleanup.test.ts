// @vitest-environment node
import { expect, test, vi } from "vite-plus/test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { BrowserService } from "./browser-service";
import { browserSessionDirectory, writeBrowserJson } from "./browser-persistence";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import {
  createRegistry,
  defineExtension,
  defineTask,
  Harness,
  type ConversationId,
} from "@earendil-works/pi-durable";
import { MemoryStorage } from "@earendil-works/pi-durable/storage/memory";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { createWorkerBrowserCleanup } from "./browser-worker-cleanup";
import { OrchestrationDoc, WorkerDoc } from "./orchestration";
import { ArchivedWorker } from "./orchestration-history";

const Delivery = defineTask<
  { childId: number; aborted?: boolean; hold?: boolean },
  { phase: "done" },
  string
>({
  name: "batty.delivery",
  version: 1,
  initial: () => ({ phase: "done" }),
  phases: {
    done: async (task, runtime, ctx) => {
      if (task.input.hold)
        await new Promise((_, reject) => {
          ctx.abortSignal!.addEventListener("abort", () => reject(ctx.abortSignal!.reason), {
            once: true,
          });
        });
      await runtime.commit(
        () => ({
          status: "terminal",
          outcome: {
            status: task.input.aborted ? "aborted" : "completed",
            result: "done",
          },
        }),
        ctx,
      );
    },
  },
  abort: async (_, runtime, ctx) => {
    await runtime.commit(
      () => ({ status: "terminal", outcome: { status: "aborted", result: "stopped" } }),
      ctx,
    );
  },
});

test("resume admission cannot interleave with expiry after idle eligibility was read", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "batty-browser-admission-"));
  const service = new BrowserService(undefined, 4, root);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let checked = false;
  let admitted = false;
  try {
    await writeBrowserJson(path.join(browserSessionDirectory(root, "worker"), "launch.json"), {
      useTailscale: false,
    });
    const expiry = service.expireWorkerSession(
      "worker",
      async () => {
        checked = true;
        await gate;
        return { taskId: "old", since: 0, stopped: false };
      },
      100,
      1_000,
    );
    await vi.waitFor(() => expect(checked).toBe(true));
    const resume = service.withSessionLifecycle("worker", async () => {
      admitted = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(admitted).toBe(false);
    release();
    await Promise.all([expiry, resume]);
    expect(admitted).toBe(true);
    expect(await service.hasSession("worker")).toBe(false);
  } finally {
    release();
    await service.dispose();
    await fs.rm(root, { recursive: true, force: true });
  }
});

async function fixture() {
  const registry = createRegistry();
  registry.install(defineExtension({ name: "test-delivery", tasks: [Delivery] }));
  const harness = await Harness.open(
    new MemoryStorage(),
    {
      models: createModels(),
      registry,
      env: () => new NodeExecutionEnv({ cwd: "/tmp" }),
    },
    context,
  );
  const main = await harness.root(context);
  const present = new Set<string>();
  const decisions: Array<{ id: string; idle: unknown }> = [];
  const browser = {
    hasSession: vi.fn(async (id: string) => present.has(id)),
    expireWorkerSession: vi.fn(async (id: string, getIdle: () => Promise<unknown>) => {
      if (present.has(id)) decisions.push({ id, idle: await getIdle() });
    }),
  };
  const cleanup = createWorkerBrowserCleanup(browser);
  async function worker({
    terminal = true,
    aborted = false,
    archived = true,
    isWorker = true,
  } = {}) {
    const result = await main.commit(async (tx) => {
      const child = await tx.createConversation({ ownership: { kind: "ownerless" } });
      const taskId = await tx.createTask(
        Delivery,
        { childId: child.id, aborted, hold: !terminal },
        {
          ownership: { kind: "conversation" },
          background: true,
        },
      );
      const state = await tx.doc(OrchestrationDoc);
      state.mainId = main.id;
      const record = {
        id: child.id,
        parentId: main.id,
        workspaceId: "test",
        prompt: "test",
        active: taskId,
        reported: [],
      };
      if (archived) await tx.doc(ArchivedWorker, String(child.id), record);
      else state.workers[String(child.id)] = record;
      (await tx.doc(WorkerDoc, child.id)).isSubagent = isWorker;
      await tx.appendEntry(child.id, {
        kind: "test.answer",
        model: [{ role: "user", content: "done", timestamp: 1_000 }],
      });
      return { id: child.id, taskId };
    }, context);
    present.add(String(result.id));
    if (terminal) {
      harness.resume();
      await harness.waitForTask(result.taskId, context);
    }
    return result;
  }
  return { harness, main, worker, present, decisions, cleanup };
}

test("startup identifies terminal archived owners without expiring interrupted workers or nonworkers", async () => {
  const f = await fixture();
  try {
    const completed = await f.worker();
    const stopped = await f.worker({ aborted: true });
    const nonworker = await f.worker({ isWorker: false });
    const interrupted = await f.worker({ terminal: false, archived: false });
    f.present.add(String(f.main.id));
    await f.cleanup.bind(f.harness);
    expect(f.decisions.find((item) => item.id === String(completed.id))?.idle).toMatchObject({
      since: 1_000,
      stopped: false,
    });
    expect(f.decisions.find((item) => item.id === String(stopped.id))?.idle).toMatchObject({
      stopped: true,
    });
    for (const id of [nonworker.id, interrupted.id, f.main.id])
      expect(f.decisions.find((item) => item.id === String(id))?.idle).toBeUndefined();
  } finally {
    await f.cleanup.close();
    await f.harness.close(context);
  }
});

test("a live completion establishes retention; a resumed pending delivery is protected", async () => {
  const f = await fixture();
  try {
    await f.cleanup.bind(f.harness);
    const completed = await f.worker();
    await vi.waitFor(() =>
      expect(f.decisions.some((item) => item.id === String(completed.id) && item.idle)).toBe(true),
    );
    const idle = f.decisions.find((item) => item.id === String(completed.id))!.idle as {
      since: number;
    };
    expect(idle.since).toBeGreaterThan(Date.now() - 5_000);
    await f.main.commit(async (tx) => {
      const taskId = await tx.createTask(
        Delivery,
        { childId: completed.id, hold: true },
        {
          ownership: { kind: "conversation" },
          background: true,
        },
      );
      (await tx.doc(OrchestrationDoc)).workers[String(completed.id)] = {
        id: completed.id as ConversationId,
        parentId: f.main.id,
        workspaceId: "test",
        prompt: "resume",
        active: taskId,
        reported: [],
      };
    }, context);
    f.decisions.length = 0;
    // Startup reconciliation must use the resumed hot record, not its old archive.
    await f.cleanup.close();
    await f.cleanup.bind(f.harness);
    expect(f.decisions.find((item) => item.id === String(completed.id))?.idle).toBeUndefined();
  } finally {
    await f.cleanup.close();
    await f.harness.close(context);
  }
});
