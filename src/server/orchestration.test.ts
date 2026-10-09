import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vite-plus/test";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
  fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import {
  createRegistry,
  defineExtension,
  defineTask,
  defineTool,
  Harness,
  InboxDoc,
  LiveDoc,
} from "@earendil-works/pi-durable";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { Type, getCurrentTools } from "@earendil-works/pi-ai";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { createOrchestration, OrchestrationDoc, type CronRun } from "./orchestration.js";
import { orchestrationHistory } from "./orchestration-test-history";
import { indexRun } from "./orchestration-history";
import { decodeRuntimeNotice } from "./runtime-notices.js";
import { registerPushCompletions } from "./push-completions.js";
import { entryMessages, type Runtime } from "./runtime.js";
import type { WebPushService } from "./web-push.js";
import { suppressAgentCompletionNotification } from "../shared/agent-notification.js";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});
const until = async (check: () => Promise<boolean>) => {
  for (let i = 0; i < 1000; i++) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("Condition did not settle");
};

async function fixture(tokensPerSecond = 10000, onError: (error: unknown) => void = console.error) {
  const directory = await mkdtemp(join(tmpdir(), "batty-orchestration-"));
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  const faux = fauxProvider({
    tokensPerSecond,
    models: [
      { id: "faux-1", reasoning: true },
      { id: "faux-2", reasoning: true },
    ],
  });
  const models = createModels();
  models.setProvider(faux.provider);
  const registry = createRegistry();
  const orchestration = createOrchestration({
    onError,
    workspaces: [
      {
        id: "test",
        path: directory,
        label: "Test",
        kind: "workspace",
        isPinned: false,
        isAssistant: false,
      },
      {
        id: "other",
        path: "/tmp",
        label: "Other",
        kind: "workspace",
        isPinned: false,
        isAssistant: false,
      },
    ],
  });
  registry.install(orchestration.extension);
  let harness: Harness;
  const open = async () => {
    harness = await Harness.open(
      await openNodeSqliteStorage(join(directory, "session.sqlite")),
      { models, registry, env: ({ cwd }) => new NodeExecutionEnv({ cwd: cwd ?? directory }) },
      context,
    );
    const main = await harness.root(context, {
      agent: { model: { provider: "faux", modelId: "faux-1" } },
    });
    await orchestration.bind(harness, main);
    return { harness, main };
  };
  cleanup.push(async () => {
    orchestration.close();
    await harness.close(context);
  });
  return { faux, orchestration, open, registry, directory };
}

test.each([true, "chat-only"] as const)(
  "context mode %s copies only prepared context into linear worker storage",
  async (mode) => {
    const { faux, orchestration, open } = await fixture();
    const { harness, main } = await open();
    await main.configure(
      { instructions: "explicit parent instructions", thinkingLevel: "medium" },
      context,
    );
    await main.commit(async (tx) => {
      await tx.appendEntry(main.id, {
        kind: "pi.user",
        model: [{ role: "user", content: "archive-only", timestamp: 1 }],
      });
    }, context);
    const calls: unknown[] = [];
    orchestration.setContextProvider(async (parentId, requestedMode) => {
      calls.push([parentId, requestedMode]);
      return [
        { role: "user", content: "frozen-visible", timestamp: 2 },
        fauxAssistantMessage([
          { type: "thinking", thinking: "hidden thought" },
          fauxText("visible assistant text"),
          fauxToolCall("read", { path: "omitted-in-chat" }),
        ]),
      ];
    });
    faux.setResponses(
      Array.from({ length: 10 }, () => (request) => {
        const last = request.messages.findLast((message) => message.role !== "system")!;
        if (last.role === "user" && JSON.stringify(last.content).includes("launch"))
          return fauxAssistantMessage(
            [
              fauxToolCall("subagent", {
                action: "run",
                async: true,
                prompt: "worker task",
                includePreviousContext: mode,
              }),
            ],
            { stopReason: "toolUse" },
          );
        return fauxAssistantMessage([fauxText("done")]);
      }),
    );
    await (await main.submit({ type: "input", content: "launch" }, context)).wait(context);
    await until(async () => (await orchestration.listRunning()).length === 0);
    const worker = Object.values((await orchestrationHistory(harness))!.workers)[0]!;
    const child = (await harness.conversation(worker.id, context))!;
    const view = await child.viewState(context);
    expect(view.value.conversation.parent).toBeUndefined();
    const copied = JSON.stringify(view.value.entries);
    expect(copied).toContain("frozen-visible");
    expect(copied).toContain("visible assistant text");
    expect(copied).not.toContain("archive-only");
    if (mode === "chat-only") {
      expect(copied).not.toContain("hidden thought");
      expect(copied).not.toContain("omitted-in-chat");
    } else expect(copied).toContain("hidden thought");
    expect(calls).toEqual([[main.id, mode]]);
    expect(await child.agent(context)).toMatchObject({
      instructions: "explicit parent instructions",
      thinkingLevel: "medium",
      model: { provider: "faux", modelId: "faux-1" },
    });
    view.dispose();
  },
  15000,
);

test("worker agent preparation applies workspace-scoped tools before generation admission", async () => {
  const { faux, orchestration, open, registry } = await fixture();
  const scoped = defineTool({
    name: "worker_scope",
    description: "scope",
    parameters: Type.Object({}),
    replay: "safe",
    execute: async (_, api) => ({ content: [{ type: "text", text: `scoped:${api.env!.cwd}` }] }),
  });
  const scopedExtension = defineExtension({ name: "worker-mcp-scope", tools: [scoped] });
  registry.install(scopedExtension);
  const { harness, main } = await open();
  await main.configure({ extensions: [orchestration.extension] }, context);
  const prepared: { cwd: string; actualCwd: string | undefined }[] = [];
  orchestration.setPrepareAgent(async (cwd, agent) => {
    prepared.push({ cwd, actualCwd: agent.cwd });
    return { extensions: [...agent.extensions, scopedExtension], tools: [scoped] };
  });
  faux.setResponses(
    Array.from({ length: 12 }, () => (request) => {
      const last = request.messages.findLast((message) => message.role !== "system")!;
      const text = JSON.stringify(last.content);
      if (last.role === "user" && text.includes("launch scoped worker"))
        return fauxAssistantMessage(
          [
            fauxToolCall("subagent", {
              action: "run",
              async: true,
              workspaceId: "other",
              prompt: "use worker scoped tool",
            }),
          ],
          { stopReason: "toolUse" },
        );
      if (last.role === "user" && text.includes("use worker scoped tool")) {
        expect(getCurrentTools(request.messages).map((tool) => tool.name)).toEqual([
          "worker_scope",
        ]);
        return fauxAssistantMessage([fauxToolCall("worker_scope", {})], { stopReason: "toolUse" });
      }
      return fauxAssistantMessage([fauxText("done")]);
    }),
  );
  await (
    await main.submit({ type: "input", content: "launch scoped worker" }, context)
  ).wait(context);
  await until(async () => (await orchestration.listRunning()).length === 0);
  expect(prepared).toEqual([{ cwd: "/tmp", actualCwd: "/tmp" }]);
  const worker = Object.values((await orchestrationHistory(harness))!.workers)[0]!;
  const messages = (await (await harness.conversation(worker.id, context))!.context(context))
    .messages;
  const result = messages.find(
    (message) => message.role === "toolResult" && message.toolName === "worker_scope",
  );
  expect(JSON.stringify(result)).toContain("scoped:/tmp");
  expect(result?.role === "toolResult" && result.isError).toBe(false);
  expect((await main.agent(context)).tools.map((tool) => tool.name)).toEqual(["subagent", "cron"]);
}, 15000);

test.each(["complete", "cancel", "restart"] as const)(
  "inline scoped extension/tool selection restores after %s",
  async (mode) => {
    const { faux, orchestration, open, registry, directory } = await fixture(
      mode === "complete" ? 10000 : 200,
    );
    let executed = false;
    const scoped = defineTool({
      name: "inline_scope",
      description: "scope",
      parameters: Type.Object({}),
      replay: "safe",
      execute: async (_, api) => {
        executed = true;
        return { content: [{ type: "text", text: `scoped:${api.env!.cwd}` }] };
      },
    });
    const scopedExtension = defineExtension({ name: "inline-mcp-scope", tools: [scoped] });
    registry.install(scopedExtension);
    let { harness, main } = await open();
    const cronTool = orchestration.extension.tools!.find((tool) => tool.name === "cron")!;
    await main.configure(
      { cwd: "/tmp", extensions: [orchestration.extension], tools: [cronTool] },
      context,
    );
    const prepared: { cwd: string; actualCwd: string | undefined }[] = [];
    orchestration.setPrepareAgent(async (cwd, agent) => {
      prepared.push({ cwd, actualCwd: agent.cwd });
      return { extensions: [...agent.extensions, scopedExtension], tools: [scoped] };
    });
    let finalStarted = false;
    faux.setResponses([
      (request) => {
        expect(getCurrentTools(request.messages).map((tool) => tool.name)).toEqual([
          "inline_scope",
        ]);
        return fauxAssistantMessage([fauxToolCall("inline_scope", {})], { stopReason: "toolUse" });
      },
      () => {
        finalStarted = true;
        return fauxAssistantMessage([
          fauxText(mode === "complete" ? "done" : "working ".repeat(1000)),
        ]);
      },
    ]);
    const job = await orchestration.addJob({
      workspaceId: "test",
      prompt: "use scoped inline tools",
      session: { kind: "main-inline" },
      schedule: { kind: "at", in: "1h" },
    });
    await main.commit(async (tx) => {
      (await tx.doc(OrchestrationDoc)).jobs[job.id]!.nextAt = Date.now() - 1;
    }, context);
    await orchestration.tick();
    await until(async () => finalStarted);
    expect(executed).toBe(true);
    if (mode === "cancel") {
      const run = (await orchestration.listRunningCron())[0]!;
      await orchestration.stopRunning(run.id);
    } else if (mode === "restart") {
      await harness.close(context);
      faux.setResponses([fauxAssistantMessage([fauxText("recovered scoped result")])]);
      ({ harness, main } = await open());
      harness.resume();
    }
    await until(
      async () =>
        (await orchestration.listRunLogs())[0]?.status ===
        (mode === "cancel" ? "aborted" : "completed"),
    );
    expect(prepared).toEqual([{ cwd: directory, actualCwd: "/tmp" }]);
    const agent = await main.agent(context);
    expect(agent.extensions.map((extension) => extension.name)).toEqual([
      orchestration.extension.name,
    ]);
    expect(agent.tools.map((tool) => tool.name)).toEqual(["cron"]);
    expect(agent.cwd).toBe("/tmp");
  },
  15000,
);

test("reopen retires only completed unchanged one-shots and preserves archived metadata", async () => {
  const state = await fixture();
  let { harness, main } = await state.open();
  const now = Date.now();
  const cases = [
    "completed",
    "failed",
    "aborted",
    "unexecuted",
    "recurring",
    "edited",
    "rearmed",
    "latest-failed",
    "active",
  ];
  for (const id of cases) {
    await state.orchestration.importJob({
      id,
      workspaceId: "test",
      prompt: `original ${id}`,
      enabled: false,
      schedule:
        id === "recurring"
          ? { kind: "every", every: "1h", everyMs: 3600000 }
          : { kind: "at", at: new Date(now - 10000).toISOString() },
      session: { kind: "main-detached" },
      createdAt: now - 20000,
      updatedAt: id === "edited" ? now : now - 20000,
      ...(id === "rearmed" ? { nextAt: now + 3600000 } : {}),
    });
    if (id === "unexecuted") continue;
    await main.commit(async (tx) => {
      const run = {
        id: `${id}:old`,
        jobId: id,
        workspaceId: "test",
        scheduledAt: now - 10000,
        startedAt: now - 9000,
        finishedAt: now - 8000,
        taskId: 1 as never,
        sessionId: String(main.id),
        status: (id === "failed" ? "failed" : id === "aborted" ? "aborted" : "completed") as
          | "completed"
          | "failed"
          | "aborted",
        output: "retained output",
      };
      if (id === "completed")
        await indexRun(tx, {
          ...run,
          id: `${id}:earlier-failure`,
          startedAt: now - 15000,
          finishedAt: now - 14000,
          status: "failed",
        });
      await indexRun(tx, run);
      if (id === "active") {
        const active: CronRun = { ...run, id: `${id}:running`, status: "running" };
        delete active.finishedAt;
        await indexRun(tx, active);
        (await tx.doc(OrchestrationDoc)).runs[active.id] = active;
      }
      if (id === "latest-failed")
        await indexRun(tx, {
          ...run,
          id: `${id}:new`,
          startedAt: now - 7000,
          finishedAt: now - 6000,
          status: "failed",
        });
    }, context);
  }
  await harness.close(context);
  ({ harness, main } = await state.open());
  expect((await state.orchestration.listJobs()).map((job) => job.id)).toEqual(cases.slice(1));
  expect((await state.orchestration.listRunLogs("active"))[1]?.job?.prompt).toBe("original active");
  const [run] = await state.orchestration.listRunLogs("completed");
  expect(run).toMatchObject({
    status: "completed",
    output: "retained output",
    job: { prompt: "original completed", session: { kind: "main-detached" } },
  });
  await harness.close(context);
  await state.open();
  const retainedRuns = await state.orchestration.listRunLogs("completed");
  expect(retainedRuns).toHaveLength(2);
  expect(retainedRuns[1]).toMatchObject({
    status: "failed",
    output: "retained output",
    job: { prompt: "original completed", session: { kind: "main-detached" } },
  });
});

test("a persisted cron admission survives reopen and reports exactly once to main", async () => {
  const fixtureState = await fixture();
  let { harness, main } = await fixtureState.open();
  const job = await fixtureState.orchestration.addJob({
    workspaceId: "test",
    prompt: "worker task",
    schedule: { kind: "at", in: "1h" },
  });
  // Move its durable deadline into the past without invoking a process-local runner.
  await main.commit(async (tx) => {
    (await tx.doc(OrchestrationDoc)).jobs[job.id]!.nextAt = Date.now() - 1;
  }, context);
  await harness.close(context);
  fixtureState.faux.setResponses([
    fauxAssistantMessage([fauxText("durable result")]),
    fauxAssistantMessage([fauxText("report received")]),
  ]);
  ({ harness, main } = await fixtureState.open());
  await fixtureState.orchestration.tick();
  await until(
    async () => (await fixtureState.orchestration.listRunLogs())[0]?.status === "completed",
  );
  await main.waitForIdle(context);
  const reports = (await main.context(context)).entries.filter((entry) =>
    entry.model?.some(
      (message) =>
        message.role === "user" && JSON.stringify(message.content).includes("durable result"),
    ),
  );
  expect(reports).toHaveLength(1);
  expect(await fixtureState.orchestration.listRunLogs()).toHaveLength(1);
  const worker = (await fixtureState.orchestration.listRunLogs())[0]!;
  expect(
    await fixtureState.orchestration.metadata(Number(worker.sessionId) as never),
  ).toMatchObject({ workspaceId: "test", isCron: true, isSubagent: false });
}, 15000);

test.each(
  (["new", "daily-detached", "main-detached", "daily-inline", "main-inline"] as const).flatMap(
    (kind) =>
      (
        ["NO_REPLY", " \nNO_REPLY\t", "normal result", "NO_REPLY with details", "error"] as const
      ).map((output) => ({ kind, output })),
  ),
)(
  "cron $kind with $output preserves history and only delivers non-silent results",
  async ({ kind, output }) => {
    const { faux, orchestration, open } = await fixture();
    const { harness, main } = await open();
    await main.configure({ cwd: "/tmp" }, context);
    const delivered: unknown[] = [];
    const reportError = vi.fn();
    const stop = registerPushCompletions(
      { harness, main, state: async () => ({ sessionId: String(main.id) }) } as unknown as Runtime,
      {
        notifyAgentCompleted: async (state) => {
          if (!suppressAgentCompletionNotification(state)) delivered.push(state);
        },
      } as WebPushService,
      reportError,
    );
    cleanup.push(async () => stop());
    faux.setResponses([
      () => {
        if (output === "error") throw new Error("cron provider failure NO_REPLY");
        return fauxAssistantMessage([fauxText(output)]);
      },
      fauxAssistantMessage([fauxText("report received")]),
    ]);
    const job = await orchestration.addJob({
      workspaceId: "test",
      prompt: "scheduled task",
      session: { kind },
      schedule: { kind: "at", in: "1h" },
    });
    await main.commit(async (tx) => {
      (await tx.doc(OrchestrationDoc)).jobs[job.id]!.nextAt = Date.now() - 1;
    }, context);
    const before = (await main.context(context)).entries.length;
    await orchestration.tick();
    await until(async () => (await orchestration.listRunningCron()).length === 0);
    await main.waitForIdle(context);
    const run = (await orchestration.listRunLogs(job.id))[0]!;
    expect(run.status).toBe(output === "error" ? "failed" : "completed");
    expect(run.finishedAt).toBeDefined();
    expect((await orchestration.listJobs()).some((item) => item.id === job.id)).toBe(
      output === "error",
    );
    expect(run.job?.prompt).toBe("scheduled task");
    expect((await harness.getTask(run.taskId, context))!.state.outcome?.status).toBe("completed");
    if (output === "error") expect(run.output).toBe(`Task ${run.sessionId} failed: model_error`);
    else expect(run.output).toBe(output);
    const inline = kind.endsWith("inline");
    const silent = output.trim() === "NO_REPLY";
    const entries = (await main.context(context)).entries.slice(before);
    const reports = entries.filter((entry) =>
      entry.model?.some((message) => {
        if (message.role !== "user") return false;
        const notice = decodeRuntimeNotice(message.content);
        return notice?.text.includes(" result]");
      }),
    );
    expect(reports).toHaveLength(!inline && !silent ? 1 : 0);
    if (!inline && silent) expect(entries).toHaveLength(0);
    const child = (await harness.conversation(Number(run.sessionId) as never, context))!;
    if (output !== "error")
      expect((await child.context(context)).messages).toContainEqual(
        expect.objectContaining({ role: "assistant", content: [fauxText(output)] }),
      );
    expect((await main.agent(context)).cwd).toBe("/tmp");
    // Drain the serialized push observer before asserting the silent cases.
    await new Promise<void>((resolve) => setImmediate(resolve));
    if (silent) expect(delivered).toHaveLength(0);
    else if (output !== "error" || !inline) expect(delivered).toHaveLength(1);
    expect(reportError).not.toHaveBeenCalled();
  },
);

test("NO_REPLY subagent results still reach their parent", async () => {
  const { faux, orchestration, open } = await fixture();
  const { main } = await open();
  faux.setResponses([
    fauxAssistantMessage(
      [fauxToolCall("subagent", { action: "run", async: true, prompt: "silent helper" })],
      { stopReason: "toolUse" },
    ),
    ...Array.from(
      { length: 5 },
      () => (request: { messages: readonly import("@earendil-works/pi-ai").Message[] }) => {
        const last = request.messages.findLast((message) => message.role !== "system")!;
        if (last.role === "user" && JSON.stringify(last.content).includes("silent helper"))
          return fauxAssistantMessage([fauxText("NO_REPLY")]);
        return fauxAssistantMessage([fauxText("parent finished")]);
      },
    ),
  ]);
  await (await main.submit({ type: "input", content: "launch" }, context)).wait(context);
  await until(async () => (await orchestration.listRunning()).length === 0);
  await main.waitForIdle(context);
  const reports = (await main.context(context)).messages.filter(
    (message) => message.role === "user" && JSON.stringify(message.content).includes("NO_REPLY"),
  );
  expect(reports).toHaveLength(1);
  expect(JSON.stringify(reports[0])).toContain("subagent");
});

test("silent detached cron creates no report or steering while main is busy", async () => {
  const { faux, orchestration, open, registry } = await fixture();
  let entered = false;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  registry.install(
    defineExtension({
      name: "busy-main",
      tools: [
        defineTool({
          name: "hold",
          description: "hold main busy",
          parameters: Type.Object({}),
          replay: "safe",
          execute: async () => {
            entered = true;
            await gate;
            return { content: [{ type: "text", text: "released" }] };
          },
        }),
      ],
    }),
  );
  const { harness, main } = await open();
  faux.setResponses([
    fauxAssistantMessage([fauxToolCall("hold", {})], { stopReason: "toolUse" }),
    fauxAssistantMessage([fauxText(" \nNO_REPLY\t")]),
    fauxAssistantMessage([fauxText("main completed")]),
  ]);
  const submission = await main.submit({ type: "input", content: "hold main" }, context);
  await until(async () => entered);
  const before = (await main.context(context)).entries.length;
  const job = await orchestration.addJob({
    prompt: "silent scheduled task",
    session: { kind: "main-detached" },
    schedule: { kind: "at", in: "1h" },
  });
  try {
    await main.commit(async (tx) => {
      (await tx.doc(OrchestrationDoc)).jobs[job.id]!.nextAt = Date.now() - 1;
    }, context);
    await orchestration.tick();
    await until(async () => (await orchestration.listRunLogs(job.id))[0]?.status === "completed");
    const run = (await orchestration.listRunLogs(job.id))[0]!;
    expect((await main.context(context)).entries).toHaveLength(before);
    expect(
      await harness.commit(
        (tx) => tx.submissionByRequest(main.id, `batty-report:${run.taskId}`),
        context,
      ),
    ).toBeUndefined();
  } finally {
    release();
  }
  await submission.wait(context);
  await main.waitForIdle(context);
  expect(
    JSON.stringify(
      (await main.context(context)).messages.filter((message) => message.role !== "system"),
    ),
  ).not.toContain("NO_REPLY");
});

test.each(
  (
    [
      ["main-detached", false],
      ["main-detached", true],
      ["daily-detached", false],
      ["daily-detached", true],
    ] as const
  ).flatMap(([kind, busy]) =>
    (["assistant", "direct"] as const).map((delivery) => [kind, busy, delivery] as const),
  ),
)("cron %s final (main busy=%s, delivery=%s)", async (kind, busy, delivery) => {
  const { faux, orchestration, open, registry } = await fixture();
  let entered = false;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  registry.install(
    defineExtension({
      name: "cron-queue-test",
      tools: [
        defineTool({
          name: "hold",
          description: "hold main",
          parameters: Type.Object({}),
          replay: "safe",
          execute: async () => {
            entered = true;
            await gate;
            return { content: [{ type: "text", text: "released" }] };
          },
        }),
      ],
    }),
  );
  const { main } = await open();
  let mainRequests = 0;
  faux.setResponses(
    Array.from({ length: 10 }, () => (request) => {
      if (
        request.messages.some(
          (message) => message.role === "user" && message.content === "hold main",
        )
      ) {
        mainRequests++;
        if (mainRequests === 2) {
          expect(
            request.messages.findLast((message) => message.role === "toolResult"),
          ).toMatchObject({ content: [fauxText("released")] });
          expect(JSON.stringify(request.messages)).not.toContain("missing_result");
        }
      }
      const last = request.messages.findLast((message) => message.role !== "system")!;
      if (last.role === "user" && JSON.stringify(last.content).includes("hold main"))
        return fauxAssistantMessage([fauxToolCall("hold", {})], { stopReason: "toolUse" });
      if (last.role === "user" && JSON.stringify(last.content).includes("scheduled work"))
        return fauxAssistantMessage([fauxText("cron final")]);
      return fauxAssistantMessage([
        fauxText(last.role === "toolResult" ? "main finished first" : "cron acknowledged"),
      ]);
    }),
  );
  const submission = busy
    ? await main.submit({ type: "input", content: "hold main" }, context)
    : undefined;
  if (busy) await until(async () => entered);
  const job = await orchestration.addJob({
    prompt: "scheduled work",
    delivery,
    session: { kind },
    schedule: { kind: "at", in: "1h" },
  });
  try {
    await main.commit(async (tx) => {
      (await tx.doc(OrchestrationDoc)).jobs[job.id]!.nextAt = Date.now() - 1;
    }, context);
    await orchestration.tick();
    await until(async () => (await orchestration.listRunLogs(job.id))[0]?.status === "completed");
    if (busy) {
      await main.commit(async (tx) => {
        const inbox = await tx.doc(InboxDoc, main.id);
        expect(inbox.items).toHaveLength(delivery === "direct" ? 0 : 1);
        if (delivery === "direct") return;
        expect(inbox.items[0]!.mode).toBe("followUp");
        const item = inbox.items[0]!;
        if (item.mode === "write") throw new Error("Expected a queued input");
        expect(decodeRuntimeNotice(item.content)?.kind).toBe("cron");
      }, context);
      if (delivery !== "direct")
        expect(JSON.stringify((await main.context(context)).messages)).not.toContain("cron final");
    }
  } finally {
    release();
  }
  await submission?.wait(context);
  await main.waitForIdle(context);
  const messages = (await main.context(context)).messages;
  const reports = messages.filter(
    (message) =>
      message.role === "user" &&
      decodeRuntimeNotice(message.content)?.kind === "cron" &&
      !decodeRuntimeNotice(message.content)?.data?.directDelivery,
  );
  expect(reports).toHaveLength(delivery === "direct" ? 0 : 1);
  const replies = messages.filter((message) => message.role === "assistant");
  if (delivery === "direct") {
    expect(mainRequests).toBe(busy ? 2 : 0);
    expect(
      entryMessages((await main.context(context)).entries).some(
        (message) =>
          message.role === "assistant" &&
          JSON.stringify(message.blocks) === JSON.stringify([fauxText("cron final")]),
      ),
    ).toBe(true);
    return;
  }
  expect(replies.at(-1)).toMatchObject({ content: [fauxText("cron acknowledged")] });
  if (busy) expect(replies.at(-2)).toMatchObject({ content: [fauxText("main finished first")] });
});

test.each(["new", "daily-inline", "main-inline"] as const)(
  "direct cron %s displays unchanged output without a main generation",
  async (kind) => {
    const { faux, orchestration, open } = await fixture();
    const { main } = await open();
    faux.setResponses([
      (request) => {
        const prompt = JSON.stringify(request.messages);
        expect(prompt).toContain("You run in a separate execution scope");
        expect(prompt).not.toContain("You run inline in the permanent main conversation");
        return fauxAssistantMessage([fauxText("full briefing\nunchanged")]);
      },
    ]);
    const job = await orchestration.addJob({
      prompt: "brief",
      delivery: "direct",
      session: { kind },
      schedule: { kind: "at", in: "1h" },
    });
    await main.commit(async (tx) => {
      (await tx.doc(OrchestrationDoc)).jobs[job.id]!.nextAt = Date.now() - 1;
    }, context);
    await orchestration.tick();
    await until(async () => (await orchestration.listRunLogs(job.id))[0]?.status === "completed");
    await main.waitForIdle(context);
    expect(entryMessages((await main.context(context)).entries)).toMatchObject([
      { role: "assistant", blocks: [fauxText("full briefing\nunchanged")] },
    ]);
    expect((await orchestration.listRunLogs(job.id))[0]!.sessionId).not.toBe(String(main.id));
  },
);

test.each(["NO_REPLY", "error"])("direct cron handles %s", async (output) => {
  const { faux, orchestration, open } = await fixture();
  const { main } = await open();
  faux.setResponses([
    () => {
      if (output === "error") throw new Error("provider failed");
      return fauxAssistantMessage([fauxText(output)]);
    },
    fauxAssistantMessage([fauxText("failure handled")]),
  ]);
  const job = await orchestration.addJob({
    prompt: "brief",
    delivery: "direct",
    schedule: { kind: "at", in: "1h" },
  });
  await main.commit(async (tx) => {
    (await tx.doc(OrchestrationDoc)).jobs[job.id]!.nextAt = Date.now() - 1;
  }, context);
  await orchestration.tick();
  await until(async () => (await orchestration.listRunningCron()).length === 0);
  await main.waitForIdle(context);
  const messages = (await main.context(context)).messages.filter(
    (message) => message.role !== "system",
  );
  if (output === "NO_REPLY") expect(messages).toEqual([]);
  else {
    expect(messages.at(-1)).toMatchObject({
      role: "assistant",
      content: [fauxText("failure handled")],
    });
    expect((await orchestration.listRunLogs(job.id))[0]!.status).toBe("failed");
  }
});

test("inline cron tools use the originating workspace and restore main cwd", async () => {
  const { faux, orchestration, open, registry, directory } = await fixture();
  registry.install(
    defineExtension({
      name: "cwd-test",
      tools: [
        defineTool({
          name: "where",
          description: "cwd",
          parameters: Type.Object({}),
          replay: "safe",
          execute: async (_, api) => ({ content: [{ type: "text", text: api.env!.cwd }] }),
        }),
      ],
    }),
  );
  const { main } = await open();
  await main.configure({ cwd: "/tmp" }, context);
  faux.setResponses([
    fauxAssistantMessage([fauxToolCall("where", {})], { stopReason: "toolUse" }),
    fauxAssistantMessage([fauxText("finished")]),
  ]);
  const job = await orchestration.addJob({
    workspaceId: "test",
    prompt: "inspect cwd",
    session: { kind: "daily-inline" },
    schedule: { kind: "at", in: "1h" },
  });
  await main.commit(async (tx) => {
    (await tx.doc(OrchestrationDoc)).jobs[job.id]!.nextAt = Date.now() - 1;
  }, context);
  await orchestration.tick();
  await until(async () => (await orchestration.listRunLogs())[0]?.status === "completed");
  const result = (await main.context(context)).messages.find((m) => m.role === "toolResult");
  expect(JSON.stringify(result)).toContain(directory);
  expect((await main.agent(context)).cwd).toBe("/tmp");
  expect(await orchestration.listRunning()).toHaveLength(0);
}, 15000);

test("inline workspace context survives a steer and subsequent tool round", async () => {
  const { faux, orchestration, open, registry, directory } = await fixture();
  const seen: string[] = [];
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  registry.install(
    defineExtension({
      name: "inline-steer-test",
      tools: [
        defineTool({
          name: "where",
          description: "cwd",
          parameters: Type.Object({}),
          replay: "safe",
          execute: async (_, api) => {
            seen.push(api.env!.cwd);
            if (seen.length === 1) await gate;
            return { content: [{ type: "text", text: api.env!.cwd }] };
          },
        }),
      ],
    }),
  );
  const { main } = await open();
  await main.configure({ cwd: "/tmp" }, context);
  faux.setResponses([
    fauxAssistantMessage([fauxToolCall("where", {})], { stopReason: "toolUse" }),
    fauxAssistantMessage([fauxToolCall("where", {})], { stopReason: "toolUse" }),
    fauxAssistantMessage([fauxText("finished")]),
  ]);
  const job = await orchestration.addJob({
    workspaceId: "test",
    prompt: "inspect cwd twice",
    session: { kind: "main-inline" },
    schedule: { kind: "at", in: "1h" },
  });
  await main.commit(async (tx) => {
    (await tx.doc(OrchestrationDoc)).jobs[job.id]!.nextAt = Date.now() - 1;
  }, context);
  await orchestration.tick();
  try {
    await until(async () => seen.length === 1);
    await main.submit(
      {
        type: "input",
        content: "additional instructions without a cron marker",
        whenBusy: "steer",
      },
      context,
    );
  } finally {
    release();
  }
  await until(async () => (await orchestration.listRunLogs())[0]?.status === "completed");
  expect(seen).toEqual([directory, directory]);
  expect((await main.agent(context)).cwd).toBe("/tmp");
}, 15000);

test("workers spawned by a worker deliver async replies only to their parent", async () => {
  const { faux, orchestration, open } = await fixture();
  const { harness, main } = await open();
  const call = (prompt: string) =>
    fauxAssistantMessage([fauxToolCall("subagent", { action: "run", async: true, prompt })], {
      stopReason: "toolUse",
    });
  faux.setResponses(
    Array.from({ length: 20 }, () => (request) => {
      const last = request.messages.findLast((m) => m.role !== "system")!;
      const text = JSON.stringify(last.content);
      if (last.role === "toolResult") return fauxAssistantMessage([fauxText("accepted")]);
      if (text.includes("start outer")) return call("start inner");
      if (text.includes("start inner")) return call("leaf task");
      if (text.includes("leaf task")) return fauxAssistantMessage([fauxText("leaf answer")]);
      return fauxAssistantMessage([fauxText("noted")]);
    }),
  );
  await (await main.submit({ type: "input", content: "start outer" }, context)).wait(context);
  await until(async () => Object.keys((await orchestrationHistory(harness))!.workers).length === 2);
  await until(async () => (await orchestration.listRunning()).length === 0);
  await main.waitForIdle(context);
  const state = (await orchestrationHistory(harness))!;
  expect(Object.values(state.workers).some((w) => w.parentId !== main.id)).toBe(true);
  const mainHistory = JSON.stringify((await main.context(context)).messages);
  expect(mainHistory).not.toContain("leaf answer");
  const outer = Object.values(state.workers).find((w) => w.parentId === main.id)!;
  const outerHistory = JSON.stringify(
    (await (await harness.conversation(outer.id, context))!.context(context)).messages,
  );
  expect(outerHistory).toContain("leaf answer");
}, 15000);

test.each(["complete", "restart", "cron-run", "cron-resume", "cron-restart"])(
  "worker await preserves its submission and target across %s",
  async (mode) => {
    const { faux, orchestration, open, registry } = await fixture();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    registry.install(
      defineExtension({
        name: "nested-await-test",
        tools: [
          defineTool({
            name: "review_gate",
            description: "hold review open",
            parameters: Type.Object({}),
            replay: "safe",
            execute: async (_, __, ctx) => {
              await new Promise<void>((resolve, reject) => {
                const abort = () => reject(ctx.abortSignal!.reason);
                ctx.abortSignal!.addEventListener("abort", abort, { once: true });
                void gate.then(() => {
                  ctx.abortSignal!.removeEventListener("abort", abort);
                  resolve();
                });
              });
              return { content: [{ type: "text", text: "review ready" }] };
            },
          }),
        ],
      }),
    );
    let { harness, main } = await open();
    const successor = defineTask<null, { phase: "done" }, string>({
      name: "test.await-successor",
      version: 1,
      abort: async (_, runtime, ctx) => {
        await runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), ctx);
      },
      initial: () => ({ phase: "done" }),
      phases: {
        done: async (_, runtime, ctx) => {
          await runtime.commit(
            () => ({
              status: "terminal",
              outcome: { status: "completed", result: "unrelated successor result" },
            }),
            ctx,
          );
        },
      },
    });
    registry.install(defineExtension({ name: "await-successor-test", tasks: [successor] }));
    const call = (args: { action: string; async?: boolean; prompt?: string; sessionId?: string }) =>
      fauxAssistantMessage([fauxToolCall("subagent", args)], { stopReason: "toolUse" });
    faux.setResponses(
      Array.from({ length: 30 }, () => (request) => {
        const last = request.messages.findLast((m) => m.role !== "system")!;
        const text = JSON.stringify(last.content);
        if (last.role === "user" && text.includes("launch await test"))
          return call({ action: "run", async: true, prompt: "outer implementation" });
        if (last.role === "user" && text.includes("outer implementation"))
          return call({
            action: "run",
            async: true,
            prompt: mode === "cron-resume" ? "preflight review" : "nested review",
          });
        if (last.role === "user" && text.includes("preflight review"))
          return fauxAssistantMessage([fauxText("preflight complete")]);
        if (last.role === "toolResult" && text.includes("preflight complete")) {
          const sessionId = JSON.stringify(request.messages).match(/Session ID: (\d+)/)![1];
          return call({ action: "resume", async: true, sessionId, prompt: "nested review" });
        }
        if (last.role === "user" && text.includes("nested review"))
          return fauxAssistantMessage([fauxToolCall("review_gate", {})], { stopReason: "toolUse" });
        if (last.role === "toolResult" && text.includes("Started. Session ID:")) {
          const sessionId = text.match(/Session ID: (\d+)/)![1];
          return call({ action: "await", sessionId });
        }
        if (last.role === "toolResult" && last.toolName === "review_gate")
          return fauxAssistantMessage([fauxText("review findings")]);
        if (last.role === "toolResult" && text.includes("review findings"))
          return fauxAssistantMessage([fauxText("implementation final report after review")]);
        return fauxAssistantMessage([fauxText("noted")]);
      }),
    );
    try {
      if (mode.startsWith("cron-")) {
        const job = await orchestration.addJob({
          prompt: "outer implementation",
          session: { kind: "daily-detached" },
          schedule: { kind: "at", in: "1h" },
        });
        await main.commit(async (tx) => {
          (await tx.doc(OrchestrationDoc)).jobs[job.id]!.nextAt = Date.now() - 1;
        }, context);
        await orchestration.tick();
      } else {
        const submission = await main.submit(
          { type: "input", content: "launch await test" },
          context,
        );
        // Main await still yields, even though the nested review remains blocked.
        await submission.wait(context);
      }
      await until(async () => {
        const state = (await orchestrationHistory(harness))!;
        const outer = Object.values(state.workers).find((w) => w.parentId === main.id);
        if (!outer) return false;
        const live = await harness.snapshot(LiveDoc, outer.id, context);
        for (const slot of live?.tools ?? []) {
          if (slot.taskId && Object.values(state.joins ?? {}).includes(slot.taskId)) return true;
        }
        return false;
      });
      const pendingHistory = JSON.stringify((await main.context(context)).messages);
      expect(pendingHistory).not.toContain("implementation final report after review");
      expect(pendingHistory).not.toContain("review findings");
      if (mode.startsWith("cron-")) {
        expect(await orchestration.listRunningCron()).toHaveLength(1);
        expect((await orchestration.listRunningCron())[0]!.output).toBeUndefined();
      }
      if (mode.endsWith("restart")) {
        // Queue/resume replaces active with a later delivery. Recovery must keep
        // the target recorded by the already-running await, not follow this tail.
        await main.commit(async (tx) => {
          const state = await tx.doc(OrchestrationDoc);
          const inner = Object.values(state.workers).find((w) => w.parentId !== main.id)!;
          inner.active = await tx.createTask(successor, null, {
            ownership: { kind: "conversation" },
            background: true,
          });
        }, context);
        await harness.close(context);
        ({ harness, main } = await open());
        harness.resume();
      }
    } finally {
      release();
    }
    await until(async () => (await orchestration.listRunning()).length === 0);
    await main.waitForIdle(context);
    const state = (await orchestrationHistory(harness))!;
    const outer = Object.values(state.workers).find((w) => w.parentId === main.id)!;
    const history = (await main.context(context)).messages
      .map((message) =>
        message.role === "user"
          ? (decodeRuntimeNotice(message.content)?.text ?? message.content)
          : JSON.stringify(message),
      )
      .join("\n");
    expect(history).toContain(
      `[${mode.startsWith("cron-") ? "cron" : "subagent"} ${outer.id} result]\nimplementation final report after review`,
    );
    expect(history).not.toContain("review findings");
    expect(history).not.toContain("(no output)");
    const outerMessages = (await (await harness.conversation(outer.id, context))!.context(context))
      .messages;
    expect(
      outerMessages.filter(
        (m) => m.role === "user" && JSON.stringify(m.content).includes("review findings"),
      ),
    ).toHaveLength(0);
    expect(
      outerMessages.filter(
        (m) => m.role === "toolResult" && JSON.stringify(m.content).includes("review findings"),
      ),
    ).toHaveLength(1);
    expect(outerMessages.findLast((m) => m.role === "assistant")).toMatchObject({
      content: [{ type: "text", text: "implementation final report after review" }],
    });
  },
  15000,
);

test.each([undefined, false])(
  "main run/resume is async with async=%s and idle results start a turn",
  async (asyncOption) => {
    const { faux, orchestration, open, registry } = await fixture();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    registry.install(
      defineExtension({
        name: "main-async-test",
        tools: [
          defineTool({
            name: "hold_worker",
            description: "hold worker",
            parameters: Type.Object({}),
            replay: "safe",
            execute: async () => {
              await gate;
              return { content: [{ type: "text", text: "released" }] };
            },
          }),
        ],
      }),
    );
    const { harness, main } = await open();
    let workerId: string | undefined;
    faux.setResponses(
      Array.from({ length: 40 }, () => (request) => {
        const last = request.messages.findLast((m) => m.role !== "system")!;
        const text = JSON.stringify(last.content);
        if (
          last.role === "user" &&
          (text.includes("launch async test") || text.includes("resume async test"))
        )
          return fauxAssistantMessage(
            [
              fauxToolCall("subagent", {
                action: text.includes("resume async test") ? "resume" : "run",
                ...(workerId ? { sessionId: workerId } : {}),
                ...(asyncOption === undefined ? {} : { async: asyncOption }),
                prompt: "held implementation",
              }),
            ],
            { stopReason: "toolUse" },
          );
        if (last.role === "user" && text.includes("held implementation"))
          return fauxAssistantMessage([fauxToolCall("hold_worker", {})], { stopReason: "toolUse" });
        if (last.role === "toolResult" && last.toolName === "hold_worker")
          return fauxAssistantMessage([fauxText("held worker final")]);
        return fauxAssistantMessage([fauxText("main available")]);
      }),
    );
    try {
      await (
        await main.submit({ type: "input", content: "launch async test" }, context)
      ).wait(context);
      const state = (await orchestrationHistory(harness))!;
      workerId = String(Object.values(state.workers)[0]!.id);
      const running = await orchestration.listRunning();
      expect(running).toHaveLength(1);
      expect(running[0]!.startedAtMs).toBeGreaterThan(Date.now() - 60000);
      expect(running[0]!.startedAtMs).toBeLessThanOrEqual(Date.now());
      expect(running[0]!.startedAtMs).toBe(state.workers[workerId]!.startedAtMs);
      const result = (await main.context(context)).messages.find(
        (m) => m.role === "toolResult" && m.toolName === "subagent",
      );
      expect(result).toMatchObject({
        details: { subagent: { async: true, respondIn: "session" } },
      });
    } finally {
      release();
    }
    await until(async () => (await orchestration.listRunning()).length === 0);
    await main.waitForIdle(context);
    let history = (await main.context(context)).messages;
    expect(
      history.some(
        (m) => m.role === "user" && JSON.stringify(m.content).includes("held worker final"),
      ),
    ).toBe(true);
    expect(history.at(-1)).toMatchObject({
      role: "assistant",
      content: [{ type: "text", text: "main available" }],
    });
    await (
      await main.submit({ type: "input", content: "resume async test" }, context)
    ).wait(context);
    await until(async () => (await orchestration.listRunning()).length === 0);
    await main.waitForIdle(context);
    history = (await main.context(context)).messages;
    const starts = history.filter((m) => m.role === "toolResult" && m.toolName === "subagent");
    expect(starts).toHaveLength(2);
    for (const start of starts)
      expect(start).toMatchObject({
        content: [{ type: "text", text: `Started. Session ID: ${workerId}` }],
        details: { subagent: { async: true } },
      });
  },
  15000,
);

test("async reports steer a busy main before its final reply", async () => {
  const { faux, orchestration, open, registry } = await fixture();
  let releaseMain!: () => void;
  let releaseWorker!: () => void;
  let mainHeld = false;
  const mainGate = new Promise<void>((resolve) => {
    releaseMain = resolve;
  });
  const workerGate = new Promise<void>((resolve) => {
    releaseWorker = resolve;
  });
  registry.install(
    defineExtension({
      name: "report-steer-test",
      tools: [
        defineTool({
          name: "hold",
          description: "hold",
          parameters: Type.Object({ main: Type.Boolean() }),
          replay: "safe",
          execute: async (args) => {
            if (args.main) {
              mainHeld = true;
              await mainGate;
            } else await workerGate;
            return { content: [{ type: "text", text: "released" }] };
          },
        }),
      ],
    }),
  );
  const { harness, main } = await open();
  let reacted = false;
  faux.setResponses(
    Array.from({ length: 30 }, () => (request) => {
      const last = request.messages.findLast((m) => m.role !== "system")!;
      const text = JSON.stringify(last.content);
      if (last.role === "user" && text.includes("launch steering test"))
        return fauxAssistantMessage(
          [fauxToolCall("subagent", { action: "run", prompt: "steering worker" })],
          { stopReason: "toolUse" },
        );
      if (last.role === "user" && text.includes("steering worker"))
        return fauxAssistantMessage([fauxToolCall("hold", { main: false })], {
          stopReason: "toolUse",
        });
      if (last.role === "toolResult" && last.toolName === "subagent")
        return fauxAssistantMessage([fauxToolCall("hold", { main: true })], {
          stopReason: "toolUse",
        });
      if (last.role === "user" && text.includes("worker steering result")) {
        reacted = true;
        return fauxAssistantMessage([fauxText("main reacted before final")]);
      }
      if (last.role === "toolResult" && last.toolName === "hold") {
        const wasMain = request.messages.some(
          (m) => m.role === "user" && JSON.stringify(m.content).includes("launch steering test"),
        );
        return fauxAssistantMessage([
          fauxText(wasMain ? "main missed steering" : "worker steering result"),
        ]);
      }
      return fauxAssistantMessage([fauxText("noted")]);
    }),
  );
  const submission = await main.submit({ type: "input", content: "launch steering test" }, context);
  try {
    await until(async () => mainHeld);
    releaseWorker();
    await until(async () => (await orchestration.listRunning()).length === 0);
  } finally {
    releaseWorker();
    releaseMain();
  }
  await submission.wait(context);
  await main.waitForIdle(context);
  expect(reacted).toBe(true);
  const history = (await main.context(context)).messages;
  expect(JSON.stringify(history)).not.toContain("main missed steering");
  expect(history.findLast((m) => m.role === "assistant")).toMatchObject({
    content: [{ type: "text", text: "main reacted before final" }],
  });
  expect(Object.values((await orchestrationHistory(harness))!.workers)).toHaveLength(1);
}, 15000);

test.each(
  [false, true].flatMap((awaitChild) => [false, true].map((fail) => ({ awaitChild, fail }))),
)(
  "worker delegation exposes session ID ($awaitChild, failed=$fail)",
  async ({ awaitChild, fail }) => {
    const { faux, orchestration, open } = await fixture(10000, () => {});
    const { harness, main } = await open();
    faux.setResponses(
      Array.from({ length: 25 }, () => (request) => {
        const last = request.messages.findLast((m) => m.role !== "system")!;
        const text = JSON.stringify(last.content);
        if (last.role === "user" && text.includes("launch sync preservation"))
          return fauxAssistantMessage(
            [fauxToolCall("subagent", { action: "run", prompt: "outer sync worker" })],
            { stopReason: "toolUse" },
          );
        if (last.role === "user" && text.includes("outer sync worker"))
          return fauxAssistantMessage(
            [
              fauxToolCall("subagent", {
                action: "run",
                async: awaitChild,
                prompt: "inner sync worker",
              }),
            ],
            { stopReason: "toolUse" },
          );
        if (last.role === "toolResult" && text.includes("Started. Session ID:"))
          return fauxAssistantMessage(
            [
              fauxToolCall("subagent", {
                action: "await",
                sessionId: text.match(/Session ID: (\d+)/)![1]!,
              }),
            ],
            { stopReason: "toolUse" },
          );
        if (last.role === "user" && text.includes("inner sync worker")) {
          if (fail) throw new Error("inner provider failure");
          return fauxAssistantMessage([fauxText("nested synchronous answer")]);
        }
        return fauxAssistantMessage([fauxText("outer completed")]);
      }),
    );
    await (
      await main.submit({ type: "input", content: "launch sync preservation" }, context)
    ).wait(context);
    await until(async () => (await orchestration.listRunning()).length === 0);
    const outer = Object.values((await orchestrationHistory(harness))!.workers).find(
      (w) => w.parentId === main.id,
    )!;
    const messages = (await (await harness.conversation(outer.id, context))!.context(context))
      .messages;
    const inner = Object.values((await orchestrationHistory(harness))!.workers).find(
      (w) => w.parentId === outer.id,
    )!;
    const result = messages.findLast((m) => m.role === "toolResult" && m.toolName === "subagent")!;
    expect(result.content).toEqual([
      {
        type: "text",
        text: fail
          ? `Subagent result. Session ID: ${inner.id}\n\nTask ${inner.id} failed: model_error`
          : `Subagent result. Session ID: ${inner.id}\n\nnested synchronous answer`,
      },
    ]);
    if (!awaitChild)
      expect(result).toMatchObject({
        details: { subagent: { async: false, respondIn: "tool-call" } },
      });
  },
  15000,
);

test.each(
  ([false, true] as const).flatMap((sync) =>
    (["assistant", "direct"] as const).map((delivery) => [sync, delivery] as const),
  ),
)(
  "cron preserves helper artifacts through synchronous=%s joins, delivery=%s",
  async (sync, delivery) => {
    const { faux, orchestration, open, registry } = await fixture();
    const file = {
      id: "f",
      storedPath: "/var/lib/batty2/sent-files/child/Cabin.jpg",
      name: "Cabin.jpg",
      size: 1,
      mimeType: "image/jpeg",
      kind: "image",
      downloadUrl: "/api/sent-files/f",
    };
    const site = { id: "s", name: "Site", url: "/api/sites/s", public: false };
    registry.install(
      defineExtension({
        name: "artifact-fixture",
        tools: [
          defineTool({
            name: "emit-artifacts",
            description: "Emit artifacts",
            parameters: Type.Object({}),
            execute: async () => ({
              content: [{ type: "text", text: "Emitted" }],
              details: {
                sentFiles: [file],
                sites: [site],
                battyFileChanges: [
                  { path: "a.ts", before: "before\n", after: "after\n", patch: "unused" },
                ],
              },
            }),
          }),
        ],
      }),
    );
    const { harness, main } = await open();
    let joinedModelInput = "";
    let reportModelInput = "";
    faux.setResponses(
      Array.from({ length: 30 }, () => (request) => {
        const last = request.messages.findLast((m) => m.role !== "system")!;
        const text = JSON.stringify(last.content);
        if (last.role === "toolResult" && text.includes("helper done")) joinedModelInput = text;
        if (last.role === "user" && text.includes("cron finished")) reportModelInput = text;
        if (last.role === "user" && text.includes("artifact outer"))
          return fauxAssistantMessage(
            [fauxToolCall("subagent", { action: "run", prompt: "artifact inner", async: !sync })],
            { stopReason: "toolUse" },
          );
        if (last.role === "user" && text.includes("artifact inner"))
          return fauxAssistantMessage([fauxToolCall("emit-artifacts", {})], {
            stopReason: "toolUse",
          });
        if (last.role === "toolResult" && last.toolName === "emit-artifacts")
          return fauxAssistantMessage([fauxText("helper done")]);
        if (
          last.role === "toolResult" &&
          last.toolName === "subagent" &&
          text.includes("Started")
        ) {
          const sessionId = text.match(/Session ID: (\d+)/)![1]!;
          return fauxAssistantMessage([fauxToolCall("subagent", { action: "await", sessionId })], {
            stopReason: "toolUse",
          });
        }
        return fauxAssistantMessage([fauxText("cron finished")]);
      }),
    );
    const job = await orchestration.addJob({
      workspaceId: "test",
      prompt: "artifact outer",
      delivery,
      schedule: { kind: "at", in: "1h" },
    });
    await main.commit(async (tx) => {
      (await tx.doc(OrchestrationDoc)).jobs[job.id]!.nextAt = Date.now() - 1;
    }, context);
    await orchestration.tick();
    await until(async () => (await orchestration.listRunLogs())[0]?.status === "completed");
    await main.waitForIdle(context);
    const reports = (await main.context(context)).messages
      .filter((m) => m.role === "user")
      .map((m) => decodeRuntimeNotice(m.content))
      .filter((notice) => notice?.data?.runtimeNotice);
    if (delivery === "direct") {
      expect(reports).toHaveLength(0);
      expect(
        entryMessages((await main.context(context)).entries).findLast(
          (message) => message.role === "assistant",
        ),
      ).toMatchObject({
        blocks: [fauxText("cron finished")],
        sentFiles: [file],
        sites: [site],
        fileChanges: [{ path: "a.ts" }],
      });
      expect(joinedModelInput).toContain(file.storedPath);
      expect(joinedModelInput).toContain("call attach-artifacts");
      expect(joinedModelInput).toContain("diff:");
      expect(joinedModelInput).toContain("site:");
      return;
    }
    expect(reports).toHaveLength(1);
    expect(reports[0]!.data!.runtimeResultArtifacts).toMatchObject({
      sentFiles: [file],
      sites: [site],
      fileChanges: [{ path: "a.ts" }],
    });
    expect(JSON.stringify(reports[0])).toContain("-before");
    for (const input of [joinedModelInput, reportModelInput]) {
      expect(input).toContain(file.storedPath);
      expect(input).toContain(file.name);
      expect(input).toContain("call attach-files");
      expect(input).toContain("Copying attachment:// links does not deliver attachments");
      expect(input).toContain("call attach-artifacts");
      expect(input).toContain("diff:");
      expect(input).toContain("site:");
    }
  },
  15000,
);

test("async subagent reports expose stored attachment paths in parent model input", async () => {
  const { faux, orchestration, open, registry } = await fixture();
  const file = {
    id: "child-file",
    name: "chosen.png",
    storedPath: "/var/lib/batty2/sent-files/child/chosen.png",
    size: 1,
    mimeType: "image/png",
    kind: "image",
    downloadUrl: "/api/sent-files/child-file",
  };
  registry.install(
    defineExtension({
      name: "async-attachment-fixture",
      tools: [
        defineTool({
          name: "attach-fixture",
          description: "Emit a child attachment",
          parameters: Type.Object({}),
          execute: async () => ({
            content: [{ type: "text", text: "Attached" }],
            details: {
              sentFiles: [file],
              sites: [{ id: "async-site", name: "Async demo", url: "/async-site", public: false }],
              fileChanges: [{ path: "async.ts", patch: "saved patch" }],
            },
          }),
        }),
      ],
    }),
  );
  const { main } = await open();
  let reportInput = "";
  faux.setResponses(
    Array.from({ length: 20 }, () => (request) => {
      const last = request.messages.findLast((m) => m.role !== "system")!;
      const text = JSON.stringify(last.content);
      if (last.role === "user" && text.includes("start attachment worker"))
        return fauxAssistantMessage(
          [fauxToolCall("subagent", { action: "run", prompt: "produce attachment" })],
          { stopReason: "toolUse" },
        );
      if (last.role === "user" && text.includes("produce attachment"))
        return fauxAssistantMessage([fauxToolCall("attach-fixture", {})], {
          stopReason: "toolUse",
        });
      if (last.role === "toolResult" && last.toolName === "attach-fixture")
        return fauxAssistantMessage([fauxText("child artifact ready")]);
      if (last.role === "user" && text.includes("child artifact ready")) reportInput = text;
      return fauxAssistantMessage([fauxText("parent acknowledged")]);
    }),
  );
  await (
    await main.submit({ type: "input", content: "start attachment worker" }, context)
  ).wait(context);
  await until(async () => (await orchestration.listRunning()).length === 0);
  await main.waitForIdle(context);
  expect(reportInput).toContain(file.name);
  expect(reportInput).toContain(file.storedPath);
  expect(reportInput).toContain("call attach-files");
  expect(reportInput).toContain("do not automatically forward every draft");
  expect(reportInput).toContain("call attach-artifacts");
  expect(reportInput).toContain("async.ts");
  expect(reportInput).toContain("Async demo");
});

test("queue admits the current report before delivering the queued prompt", async () => {
  const { faux, orchestration, open } = await fixture(1000);
  const { harness, main } = await open();
  let workerId = "";
  faux.setResponses(
    Array.from({ length: 20 }, () => (request) => {
      const last = request.messages.findLast((m) => m.role !== "system")!;
      const text = JSON.stringify(last.content);
      if (last.role === "toolResult") return fauxAssistantMessage([fauxText("accepted")]);
      if (text.includes("start queue test"))
        return fauxAssistantMessage(
          [fauxToolCall("subagent", { action: "run", async: true, prompt: "first worker prompt" })],
          { stopReason: "toolUse" },
        );
      if (text.includes("queue next"))
        return fauxAssistantMessage(
          [
            fauxToolCall("subagent", {
              action: "queue",
              sessionId: workerId,
              prompt: "second worker prompt",
            }),
          ],
          { stopReason: "toolUse" },
        );
      if (text.includes("first worker prompt"))
        return fauxAssistantMessage([fauxText("first ".repeat(1000))]);
      if (text.includes("second worker prompt"))
        return fauxAssistantMessage([fauxText("second result")]);
      return fauxAssistantMessage([fauxText("noted")]);
    }),
  );
  await (await main.submit({ type: "input", content: "start queue test" }, context)).wait(context);
  const initial = Object.values((await orchestrationHistory(harness))!.workers)[0]!;
  workerId = String(initial.id);
  const firstTask = initial.active!;
  await (await main.submit({ type: "input", content: "queue next" }, context)).wait(context);
  const secondTask = (await orchestrationHistory(harness))!.workers[workerId]!.active!;
  expect(secondTask).not.toBe(firstTask);
  await until(async () => (await orchestration.listRunning()).length === 0);
  const admissions = await main.commit(
    async (tx) => ({
      report: await tx.submissionByRequest(main.id, `batty-report:${firstTask}`),
      queued: await tx.submissionByRequest(initial.id, `batty-deliver:${secondTask}`),
    }),
    context,
  );
  expect(admissions.report!.id).toBeLessThan(admissions.queued!.id);
}, 15000);

test("concurrent queues chain transactionally and defer worker configuration", async () => {
  const { faux, orchestration, open, registry, directory } = await fixture();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const seen: string[] = [];
  registry.install(
    defineExtension({
      name: "queue-probe",
      tools: [
        defineTool({
          name: "probe",
          description: "probe",
          parameters: Type.Object({}),
          replay: "safe",
          execute: async (_, api) => {
            seen.push(api.env!.cwd);
            if (seen.length === 1) await gate;
            return { content: [{ type: "text", text: `probe-${seen.length}` }] };
          },
        }),
      ],
    }),
  );
  const { harness, main } = await open();
  let workerId = "";
  faux.setResponses(
    Array.from({ length: 30 }, () => (request) => {
      const last = request.messages.findLast((message) => message.role !== "system")!;
      const text = JSON.stringify(last.content);
      if (last.role === "user" && text.includes("launch probe"))
        return fauxAssistantMessage(
          [fauxToolCall("subagent", { action: "run", async: true, prompt: "first probe" })],
          { stopReason: "toolUse" },
        );
      if (last.role === "user" && text.includes("queue pair"))
        return fauxAssistantMessage(
          [
            fauxToolCall("subagent", {
              action: "queue",
              sessionId: workerId,
              prompt: "queued-one",
              workspaceId: "other",
              effort: "high",
            }),
            fauxToolCall("subagent", {
              action: "queue",
              sessionId: workerId,
              prompt: "queued-two",
              workspaceId: "other",
              effort: "low",
            }),
          ],
          { stopReason: "toolUse" },
        );
      if (
        (last.role === "user" && text.includes("first probe")) ||
        (last.role === "toolResult" && last.toolName === "probe" && text.includes("probe-1"))
      )
        return fauxAssistantMessage([fauxToolCall("probe", {})], { stopReason: "toolUse" });
      return fauxAssistantMessage([fauxText("done")]);
    }),
  );
  await (await main.submit({ type: "input", content: "launch probe" }, context)).wait(context);
  const original = Object.values((await orchestrationHistory(harness))!.workers)[0]!;
  workerId = String(original.id);
  const firstTask = original.active!;
  try {
    await until(async () => seen.length === 1);
    await (await main.submit({ type: "input", content: "queue pair" }, context)).wait(context);
    const state = (await orchestrationHistory(harness))!;
    const queued = Object.values(state.calls)
      .filter((call) => call.taskId !== firstTask)
      .map((call) => call.taskId)
      .sort((a, b) => a - b);
    expect(queued).toHaveLength(2);
    expect((await harness.getTask(queued[0]!, context))!.input).toMatchObject({
      previous: firstTask,
    });
    expect((await harness.getTask(queued[1]!, context))!.input).toMatchObject({
      previous: queued[0],
    });
    expect((await (await harness.conversation(original.id, context))!.agent(context)).cwd).toBe(
      directory,
    );
  } finally {
    release();
  }
  await until(async () => (await orchestration.listRunning()).length === 0);
  expect(seen).toEqual([directory, directory]);
  const agent = await (await harness.conversation(original.id, context))!.agent(context);
  expect(agent.cwd).toBe("/tmp");
  expect(agent.thinkingLevel).toBe("low");
}, 15000);

test("concurrent resumes admit only one new worker turn", async () => {
  const { faux, orchestration, open } = await fixture(200);
  const { harness, main } = await open();
  let workerId = "";
  faux.setResponses(
    Array.from({ length: 20 }, () => (request) => {
      const last = request.messages.findLast((message) => message.role !== "system")!;
      const text = JSON.stringify(last.content);
      if (last.role === "user" && text.includes("initial launch"))
        return fauxAssistantMessage(
          [fauxToolCall("subagent", { action: "run", async: true, prompt: "initial worker" })],
          { stopReason: "toolUse" },
        );
      if (last.role === "user" && text.includes("resume pair"))
        return fauxAssistantMessage(
          [
            fauxToolCall("subagent", {
              action: "resume",
              async: true,
              sessionId: workerId,
              prompt: "resumed-one",
            }),
            fauxToolCall("subagent", {
              action: "resume",
              async: true,
              sessionId: workerId,
              prompt: "resumed-two",
            }),
          ],
          { stopReason: "toolUse" },
        );
      if (last.role === "user" && (text.includes("resumed-one") || text.includes("resumed-two")))
        return fauxAssistantMessage([fauxText("working ".repeat(500))]);
      return fauxAssistantMessage([fauxText("done")]);
    }),
  );
  await (await main.submit({ type: "input", content: "initial launch" }, context)).wait(context);
  await until(async () => (await orchestration.listRunning()).length === 0);
  await main.waitForIdle(context);
  workerId = Object.keys((await orchestrationHistory(harness))!.workers)[0]!;
  await (await main.submit({ type: "input", content: "resume pair" }, context)).wait(context);
  expect(Object.keys((await orchestrationHistory(harness))!.calls)).toHaveLength(2);
  const failures = (await main.context(context)).messages.filter(
    (message) => message.role === "toolResult" && message.isError,
  );
  expect(failures).toHaveLength(1);
  expect(JSON.stringify(failures)).toContain("Subagent is running");
}, 15000);

test("subagent stop cancels the active delivery and its queued tail", async () => {
  const { faux, orchestration, open } = await fixture(300);
  const { harness, main } = await open();
  let workerId = "";
  faux.setResponses(
    Array.from({ length: 20 }, () => (request) => {
      const last = request.messages.findLast((message) => message.role !== "system")!;
      const text = JSON.stringify(last.content);
      if (last.role === "user" && text.includes("launch stoppable"))
        return fauxAssistantMessage(
          [fauxToolCall("subagent", { action: "run", async: true, prompt: "long worker task" })],
          { stopReason: "toolUse" },
        );
      if (last.role === "user" && text.includes("queue stoppable"))
        return fauxAssistantMessage(
          [
            fauxToolCall("subagent", {
              action: "queue",
              sessionId: workerId,
              prompt: "queued worker must never start",
            }),
          ],
          { stopReason: "toolUse" },
        );
      if (last.role === "user" && text.includes("stop worker"))
        return fauxAssistantMessage(
          [fauxToolCall("subagent", { action: "stop", sessionId: workerId })],
          { stopReason: "toolUse" },
        );
      if (last.role === "user" && text.includes("long worker task"))
        return fauxAssistantMessage([fauxText("working ".repeat(1000))]);
      return fauxAssistantMessage([fauxText("done")]);
    }),
  );
  await (await main.submit({ type: "input", content: "launch stoppable" }, context)).wait(context);
  workerId = Object.keys((await orchestrationHistory(harness))!.workers)[0]!;
  await (await main.submit({ type: "input", content: "queue stoppable" }, context)).wait(context);
  await (await main.submit({ type: "input", content: "stop worker" }, context)).wait(context);
  await until(async () => (await orchestration.listRunning()).length === 0);
  const worker = (await harness.conversation(Number(workerId) as never, context))!;
  expect(JSON.stringify((await worker.context(context)).messages)).not.toContain(
    "queued worker must never start",
  );
  for (const call of Object.values((await orchestrationHistory(harness))!.calls)) {
    const task = await harness.waitForTask(call.taskId, context);
    expect(task.state.outcome.status).toBe("aborted");
  }
}, 15000);

test("a worker's cron tool defaults to its originating workspace", async () => {
  const { faux, orchestration, open } = await fixture();
  const { main } = await open();
  faux.setResponses(
    Array.from({ length: 12 }, () => (request) => {
      const last = request.messages.findLast((message) => message.role !== "system")!;
      const text = JSON.stringify(last.content);
      if (last.role === "user" && text.includes("launch scheduler"))
        return fauxAssistantMessage(
          [
            fauxToolCall("subagent", {
              action: "run",
              async: true,
              workspaceId: "other",
              prompt: "schedule future worker task",
            }),
          ],
          { stopReason: "toolUse" },
        );
      if (last.role === "user" && text.includes("schedule future worker task"))
        return fauxAssistantMessage(
          [
            fauxToolCall("cron", {
              action: "add",
              prompt: "future scheduled task",
              schedule: { kind: "at", in: "1h" },
            }),
          ],
          { stopReason: "toolUse" },
        );
      return fauxAssistantMessage([fauxText("done")]);
    }),
  );
  await (await main.submit({ type: "input", content: "launch scheduler" }, context)).wait(context);
  await until(async () => (await orchestration.listJobs()).length === 1);
  expect((await orchestration.listJobs())[0]!.workspaceId).toBe("other");
}, 15000);

test("imported cron preserves identity and interval phase across restart without admitting paused jobs", async () => {
  const { orchestration, open } = await fixture();
  let { harness } = await open();
  const job = {
    id: "legacy-job",
    workspaceId: "other",
    enabled: false,
    prompt: "legacy prompt",
    model: "faux/faux-2",
    thinkingLevel: "high",
    session: { kind: "daily-detached" as const, includePreviousContext: "chat-only" as const },
    schedule: { kind: "every" as const, every: "5m", everyMs: 300000 },
    createdAt: 1000,
    updatedAt: 2000,
    nextAt: Date.now() - 1234,
  };
  expect(await orchestration.importJob(job)).toEqual(job);
  await expect(orchestration.importJob({ ...job, prompt: "overwrite" })).rejects.toThrow(
    "already exists",
  );
  await orchestration.tick();
  expect(await orchestration.listRunningCron()).toEqual([]);
  orchestration.close();
  await harness.close(context);
  ({ harness } = await open());
  expect(await orchestration.listJobs("other")).toEqual([job]);
  expect((await orchestration.updateJob(job.id, { enabled: true })).nextAt).toBe(job.nextAt);
});

test("cutover reconciles a legacy occurrence executed after the disabled import", async () => {
  const { orchestration, open } = await fixture();
  await open();
  const oldOccurrence = Date.now() - 1000;
  const imported = {
    id: "cutover-job",
    workspaceId: "test",
    enabled: false,
    prompt: "legacy",
    session: { kind: "daily-detached" as const },
    schedule: { kind: "every" as const, every: "5m", everyMs: 300000 },
    createdAt: 1000,
    updatedAt: 2000,
    nextAt: oldOccurrence,
  };
  await orchestration.importJob(imported);
  // Batty1 executes oldOccurrence, then is disabled. Its final checkpoint advances one interval.
  const finalCheckpoint = oldOccurrence + 300000;
  await orchestration.removeJob(imported.id);
  await orchestration.importJob({ ...imported, nextAt: finalCheckpoint });
  await orchestration.updateJob(imported.id, { enabled: true });
  await orchestration.tick();
  expect(await orchestration.listRunLogs()).toEqual([]);
  expect((await orchestration.listJobs())[0]!.nextAt).toBe(finalCheckpoint);
});

test("cron import rejects invalid settings before persistence and accepts historical paused at jobs", async () => {
  const { orchestration, open } = await fixture();
  await open();
  const base = {
    id: "historical",
    workspaceId: "test",
    enabled: false,
    prompt: "done",
    session: { kind: "new" as const },
    schedule: { kind: "at" as const, at: "2020-01-01T00:00:00.000Z" },
    createdAt: 1000,
    updatedAt: 2000,
  };
  await expect(orchestration.importJob({ ...base, nextAt: NaN })).rejects.toThrow("timestamp");
  await expect(orchestration.importJob({ ...base, workspaceId: "missing" })).rejects.toThrow();
  await expect(orchestration.importJob({ ...base, thinkingLevel: "invalid" })).rejects.toThrow(
    "thinking",
  );
  await expect(
    orchestration.importJob({
      ...base,
      schedule: { kind: "cron", expression: "invalid", timezone: "UTC" },
    }),
  ).rejects.toThrow();
  expect(await orchestration.listJobs()).toEqual([]);
  expect(await orchestration.importJob(base)).toEqual(base);
});

test("stopping a waiting inline cron does not abort main or withdraw ordinary queued input", async () => {
  const { faux, orchestration, open, registry } = await fixture();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let entered = false;
  registry.install(
    defineExtension({
      name: "main-gate",
      tools: [
        defineTool({
          name: "gate",
          description: "gate",
          parameters: Type.Object({}),
          replay: "safe",
          execute: async () => {
            entered = true;
            await gate;
            return { content: [{ type: "text", text: "released" }] };
          },
        }),
      ],
    }),
  );
  const { main } = await open();
  faux.setResponses([
    fauxAssistantMessage([fauxToolCall("gate", {})], { stopReason: "toolUse" }),
    fauxAssistantMessage([fauxText("user answer")]),
    fauxAssistantMessage([fauxText("queued user answer")]),
  ]);
  const user = await main.submit({ type: "input", content: "ordinary user task" }, context);
  try {
    await until(async () => entered);
    const queuedUser = await main.submit(
      { type: "input", content: "ordinary queued user" },
      context,
    );
    const job = await orchestration.addJob({
      prompt: "cron must not start",
      session: { kind: "main-inline" },
      schedule: { kind: "at", in: "1h" },
    });
    await main.commit(async (tx) => {
      (await tx.doc(OrchestrationDoc)).jobs[job.id]!.nextAt = Date.now() - 1;
    }, context);
    await orchestration.tick();
    const run = (await orchestration.listRunningCron())[0]!;
    await orchestration.stopRunning(run.id);
    await until(async () => (await orchestration.listRunLogs())[0]?.status === "aborted");
    expect((await user.status(context)).status).toBe("placed");
    expect((await queuedUser.status(context)).status).toBe("queued");
    release();
    expect((await user.wait(context)).status).toBe("done");
    expect((await queuedUser.wait(context)).status).toBe("done");
  } finally {
    release();
  }
}, 15000);

test("inline model/thinking overrides survive restart and restore the main agent", async () => {
  const { faux, orchestration, open } = await fixture(100);
  let { harness, main } = await open();
  await main.configure({ cwd: "/tmp", thinkingLevel: "low" }, context);
  const seen: { model: string; reasoning: unknown }[] = [];
  faux.setResponses([
    (request, options, _, model) => {
      seen.push({ model: model.id, reasoning: options?.reasoning });
      return fauxAssistantMessage([fauxText("working ".repeat(1000))]);
    },
  ]);
  const job = await orchestration.addJob({
    prompt: "scoped cron",
    model: "faux/faux-2",
    thinkingLevel: "high",
    session: { kind: "main-inline" },
    schedule: { kind: "at", in: "1h" },
  });
  await main.commit(async (tx) => {
    (await tx.doc(OrchestrationDoc)).jobs[job.id]!.nextAt = Date.now() - 1;
  }, context);
  await orchestration.tick();
  await until(async () => seen.length === 1);
  expect((await main.agent(context)).model?.modelId).toBe("faux-2");
  await harness.close(context);
  faux.setResponses([
    (request, options, _, model) => {
      seen.push({ model: model.id, reasoning: options?.reasoning });
      return fauxAssistantMessage([fauxText("recovered inline result")]);
    },
  ]);
  ({ harness, main } = await open());
  harness.resume();
  await until(async () => (await orchestration.listRunLogs())[0]?.status === "completed");
  expect(seen).toEqual([
    { model: "faux-2", reasoning: "high" },
    { model: "faux-2", reasoning: "high" },
  ]);
  expect(await main.agent(context)).toMatchObject({
    cwd: "/tmp",
    model: { modelId: "faux-1" },
    thinkingLevel: "low",
  });
  expect((await orchestrationHistory(harness))!.inlineContext).toBeUndefined();
}, 15000);

test("an admitted legacy inline cron retains its workspace after restart", async () => {
  const { faux, open } = await fixture(100);
  let { harness, main } = await open();
  await main.configure({ cwd: "/tmp" }, context);
  let requests = 0;
  faux.setResponses([
    () => {
      requests++;
      return fauxAssistantMessage([fauxText("working ".repeat(1000))]);
    },
  ]);
  const marker = `<batty-cron-context>${JSON.stringify({ cwd: "/var/tmp", runId: "legacy-run" })}</batty-cron-context>\nlegacy cron task`;
  await main.submit({ type: "input", content: marker }, context);
  await until(async () => requests === 1);
  expect((await main.agent(context)).cwd).toBe("/var/tmp");
  await harness.close(context);
  faux.setResponses([
    async () => {
      expect((await main.agent(context)).cwd).toBe("/var/tmp");
      return fauxAssistantMessage([fauxText("legacy task completed")]);
    },
  ]);
  ({ harness, main } = await open());
  harness.resume();
  await main.waitForIdle(context);
  expect((await main.agent(context)).cwd).toBe("/tmp");
}, 15000);

test("stopping an active inline cron preserves queued user input and restores scoped settings", async () => {
  const { faux, orchestration, open } = await fixture(100);
  const { main } = await open();
  await main.configure({ cwd: "/tmp", thinkingLevel: "low" }, context);
  let entered = false;
  faux.setResponses([
    () => {
      entered = true;
      return fauxAssistantMessage([fauxText("working ".repeat(1000))]);
    },
  ]);
  const job = await orchestration.addJob({
    prompt: "cancel scoped cron",
    model: "faux/faux-2",
    thinkingLevel: "high",
    session: { kind: "main-inline" },
    schedule: { kind: "at", in: "1h" },
  });
  await main.commit(async (tx) => {
    (await tx.doc(OrchestrationDoc)).jobs[job.id]!.nextAt = Date.now() - 1;
  }, context);
  await orchestration.tick();
  await until(async () => entered);
  const queued = await main.submit(
    { type: "input", content: "unrelated ordinary queued user" },
    context,
  );
  const run = (await orchestration.listRunningCron())[0]!;
  await orchestration.stopRunning(run.id);
  await until(async () => (await orchestration.listRunLogs())[0]?.status === "aborted");
  expect((await queued.status(context)).status).toBe("queued");
  expect(await main.agent(context)).toMatchObject({
    cwd: "/tmp",
    model: { modelId: "faux-1" },
    thinkingLevel: "low",
  });
  faux.setResponses(Array.from({ length: 5 }, () => fauxAssistantMessage([fauxText("done")])));
  await main.submit({ type: "input", content: "continue normal work" }, context);
  expect((await queued.wait(context)).status).toBe("done");
}, 15000);

test("cron isolates a bad job and its timer continues after the job is repaired", async () => {
  const errors: unknown[] = [];
  const { faux, orchestration, open } = await fixture(10000, (error) => {
    errors.push(error);
  });
  const { main } = await open();
  faux.setResponses(Array.from({ length: 10 }, () => fauxAssistantMessage([fauxText("done")])));
  const bad = await orchestration.addJob({
    prompt: "bad workspace",
    schedule: { kind: "at", in: "1h" },
  });
  const good = await orchestration.addJob({
    prompt: "good workspace",
    schedule: { kind: "at", in: "1h" },
  });
  await main.commit(async (tx) => {
    const jobs = (await tx.doc(OrchestrationDoc)).jobs;
    jobs[bad.id]!.workspaceId = "missing";
    jobs[bad.id]!.nextAt = Date.now() - 1;
    jobs[good.id]!.nextAt = Date.now() - 1;
  }, context);
  await orchestration.tick();
  await until(async () => (await orchestration.listRunLogs(good.id))[0]?.status === "completed");
  expect(errors).toHaveLength(1);
  expect((await orchestration.listJobs()).find((job) => job.id === bad.id)!.retryAt).toBeDefined();
  await orchestration.updateJob(bad.id, { workspaceId: "test" });
  // No explicit tick: the rearmed timer must admit the repaired job.
  await until(async () => (await orchestration.listRunLogs(bad.id))[0]?.status === "completed");
}, 15000);

test("cron admission retries updated job fields rather than admitting a stale snapshot", async () => {
  const { faux, orchestration, open } = await fixture();
  const { harness, main } = await open();
  faux.setResponses(Array.from({ length: 10 }, () => fauxAssistantMessage([fauxText("done")])));
  const job = await orchestration.addJob({
    prompt: "old prompt",
    session: { kind: "new", includePreviousContext: true },
    schedule: { kind: "at", in: "1h" },
  });
  await main.commit(async (tx) => {
    (await tx.doc(OrchestrationDoc)).jobs[job.id]!.nextAt = Date.now() - 1;
  }, context);
  let changed = false;
  orchestration.setContextProvider(async () => {
    if (!changed) {
      changed = true;
      await orchestration.updateJob(job.id, { prompt: "new prompt" });
    }
    return [];
  });
  await orchestration.tick();
  await until(async () => (await orchestration.listRunLogs(job.id))[0]?.status === "completed");
  const run = (await orchestration.listRunLogs(job.id))[0]!;
  const child = await orchestration.metadata(Number(run.sessionId) as never);
  expect(child?.isCron).toBe(true);
  const worker = (await harness.conversation(Number(run.sessionId) as never, context))!;
  const transcript = JSON.stringify((await worker.context(context)).messages);
  expect(transcript).toContain("new prompt");
  expect(transcript).not.toContain("old prompt");
}, 15000);

test.each([
  ["daily-detached", false],
  ["main-inline", false],
  ["daily-detached", true],
  ["main-inline", true],
] as const)(
  "cron %s joins parallel children (late=%s) and finishes postprocessing before delivery",
  async (kind, late) => {
    const { faux, orchestration, open, registry } = await fixture();
    let releaseChild!: () => void;
    let releaseParent!: () => void;
    const childGate = new Promise<void>((resolve) => {
      releaseChild = resolve;
    });
    const parentGate = new Promise<void>((resolve) => {
      releaseParent = resolve;
    });
    let releaseFast!: () => void;
    let releaseBetween!: () => void;
    const fastGate = new Promise<void>((resolve) => {
      releaseFast = resolve;
    });
    const betweenGate = new Promise<void>((resolve) => {
      releaseBetween = resolve;
    });
    let continuing = false;
    let processing = false;
    registry.install(
      defineExtension({
        name: "parallel-join-test",
        tools: [
          defineTool({
            name: "join_gate",
            description: "hold child or postprocessing",
            parameters: Type.Object({
              parent: Type.Boolean(),
              fast: Type.Optional(Type.Boolean()),
              between: Type.Optional(Type.Boolean()),
            }),
            replay: "safe",
            execute: async ({ parent, fast, between }) => {
              if (fast) {
                await fastGate;
                return { content: [{ type: "text", text: "fast ready" }] };
              }
              if (between) {
                continuing = true;
                await betweenGate;
                return { content: [{ type: "text", text: "continue joins" }] };
              }
              if (parent) processing = true;
              await (parent ? parentGate : childGate);
              return { content: [{ type: "text", text: parent ? "processed" : "child ready" }] };
            },
          }),
        ],
      }),
    );
    const { harness, main } = await open();
    const call = (args: { action: string; sessionId: string }) =>
      fauxAssistantMessage([fauxToolCall("subagent", args)], { stopReason: "toolUse" });
    faux.setResponses(
      Array.from({ length: 60 }, () => (request) => {
        const last = request.messages.findLast((m) => m.role !== "system")!;
        const text = JSON.stringify(last.content);
        if (last.role === "user" && text.includes("parallel cron"))
          return fauxAssistantMessage(
            [
              fauxToolCall("subagent", {
                action: "run",
                async: true,
                prompt: "slow parallel child",
              }),
              fauxToolCall("subagent", {
                action: "run",
                async: true,
                prompt: "fast parallel child",
              }),
            ],
            { stopReason: "toolUse" },
          );
        if (last.role === "user" && text.includes("slow parallel child"))
          return fauxAssistantMessage([fauxToolCall("join_gate", { parent: false })], {
            stopReason: "toolUse",
          });
        if (last.role === "user" && text.includes("fast parallel child"))
          return late
            ? fauxAssistantMessage([fauxToolCall("join_gate", { parent: false, fast: true })], {
                stopReason: "toolUse",
              })
            : fauxAssistantMessage([fauxText("fast findings")]);
        if (last.role === "toolResult" && text.includes("fast ready"))
          return fauxAssistantMessage([fauxText("fast findings")]);
        if (last.role === "toolResult" && text.includes("Started. Session ID:")) {
          const started = request.messages.filter(
            (m) =>
              m.role === "toolResult" && JSON.stringify(m.content).includes("Started. Session ID:"),
          );
          return call({
            action: "await",
            sessionId: JSON.stringify(started[0]!.content).match(/Session ID: (\d+)/)![1]!,
          });
        }
        if (last.role === "toolResult" && text.includes("child ready"))
          return fauxAssistantMessage([fauxText("slow findings")]);
        if (last.role === "toolResult" && text.includes("slow findings") && late)
          return fauxAssistantMessage(
            [fauxToolCall("join_gate", { parent: false, between: true })],
            { stopReason: "toolUse" },
          );
        if (
          last.role === "toolResult" &&
          (text.includes("slow findings") || text.includes("continue joins"))
        ) {
          const started = request.messages.filter(
            (m) =>
              m.role === "toolResult" && JSON.stringify(m.content).includes("Started. Session ID:"),
          );
          return call({
            action: "await",
            sessionId: JSON.stringify(started[1]!.content).match(/Session ID: (\d+)/)![1]!,
          });
        }
        if (last.role === "toolResult" && text.includes("fast findings"))
          return fauxAssistantMessage([fauxToolCall("join_gate", { parent: true })], {
            stopReason: "toolUse",
          });
        if (last.role === "toolResult" && text.includes("processed"))
          return fauxAssistantMessage([fauxText("combined cron final")]);
        return fauxAssistantMessage([fauxText("noted")]);
      }),
    );
    const job = await orchestration.addJob({
      prompt: "parallel cron",
      session: { kind: kind as "daily-detached" | "main-inline" },
      schedule: { kind: "at", in: "1h" },
    });
    await main.commit(async (tx) => {
      (await tx.doc(OrchestrationDoc)).jobs[job.id]!.nextAt = Date.now() - 1;
    }, context);
    await orchestration.tick();
    try {
      await until(async () => {
        const state = (await orchestrationHistory(harness))!;
        const fast = Object.values(state.workers).find((w) => w.prompt === "fast parallel child");
        return (
          !!fast?.active &&
          (late || (await harness.getTask(fast.active, context))?.state.status === "terminal") &&
          Object.keys(state.joins ?? {}).length > 0
        );
      });
      expect(await orchestration.listRunningCron()).toHaveLength(1);
      releaseChild();
      if (late) {
        await until(async () => continuing);
        releaseFast();
        await until(async () => {
          const state = (await orchestrationHistory(harness))!;
          const fast = Object.values(state.workers).find(
            (w) => w.prompt === "fast parallel child",
          )!;
          return (await harness.getTask(fast.active!, context))?.state.status === "terminal";
        });
        releaseBetween();
      }
      await until(async () => processing);
      expect(await orchestration.listRunningCron()).toHaveLength(1);
      expect(JSON.stringify((await main.context(context)).messages)).not.toContain(
        "combined cron final",
      );
      const run = (await orchestration.listRunningCron())[0]!;
      const parent = (await harness.conversation(Number(run.sessionId) as never, context))!;
      expect(
        (await parent.context(context)).messages.filter(
          (m) => m.role === "user" && JSON.stringify(m.content).includes("findings"),
        ),
      ).toHaveLength(0);
    } finally {
      releaseChild();
      releaseParent();
      releaseFast();
      releaseBetween();
    }
    await until(async () => (await orchestration.listRunningCron()).length === 0);
    await main.waitForIdle(context);
    expect((await orchestration.listRunLogs(job.id))[0]!.output).toBe("combined cron final");
    if (kind === "daily-detached")
      expect(
        (await main.context(context)).messages.filter(
          (m) => m.role === "user" && JSON.stringify(m.content).includes("combined cron final"),
        ),
      ).toHaveLength(1);
  },
  15000,
);

test("closing in-flight background work resumes the same child input and report", async () => {
  const { faux, orchestration, open } = await fixture(100);
  let { harness, main } = await open();
  faux.setResponses(
    Array.from({ length: 10 }, () => (request) => {
      const last = request.messages.findLast((m) => m.role !== "system")!;
      const text = JSON.stringify(last.content);
      if (text.includes("start slow"))
        return fauxAssistantMessage(
          [fauxToolCall("subagent", { action: "run", async: true, prompt: "slow child" })],
          { stopReason: "toolUse" },
        );
      if (text.includes("slow child"))
        return fauxAssistantMessage([fauxText("working ".repeat(300))]);
      return fauxAssistantMessage([fauxText("accepted")]);
    }),
  );
  await main.submit({ type: "input", content: "start slow" }, context);
  await until(async () => Object.keys((await orchestrationHistory(harness))!.workers).length === 1);
  const worker = Object.values((await orchestrationHistory(harness))!.workers)[0]!;
  await until(async () =>
    JSON.stringify(
      (await (await harness.conversation(worker.id, context))!.context(context)).messages,
    ).includes("slow child"),
  );
  await harness.close(context);
  faux.setResponses(
    Array.from({ length: 10 }, () => (request) => {
      const last = request.messages.findLast((m) => m.role !== "system")!;
      return fauxAssistantMessage([
        fauxText(JSON.stringify(last.content).includes("slow child") ? "recovered child" : "noted"),
      ]);
    }),
  );
  ({ harness, main } = await open());
  harness.resume();
  await until(async () => (await orchestration.listRunning()).length === 0);
  await main.waitForIdle(context);
  const child = (await harness.conversation(worker.id, context))!;
  expect(
    (await child.context(context)).messages.filter(
      (m) => m.role === "user" && JSON.stringify(m.content).includes("slow child"),
    ),
  ).toHaveLength(1);
  expect(
    (await main.context(context)).messages.filter(
      (m) => m.role === "user" && JSON.stringify(m.content).includes("recovered child"),
    ),
  ).toHaveLength(1);
}, 15000);
