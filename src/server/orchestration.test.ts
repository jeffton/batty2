import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vite-plus/test";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
  fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import { createRegistry, defineExtension, defineTool, Harness } from "@earendil-works/pi-durable";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { Type, getCurrentTools } from "@earendil-works/pi-ai";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { createOrchestration, OrchestrationDoc } from "./orchestration.js";

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
    const worker = Object.values((await harness.snapshot(OrchestrationDoc, context))!.workers)[0]!;
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
  const worker = Object.values((await harness.snapshot(OrchestrationDoc, context))!.workers)[0]!;
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

test("workers spawned by a worker still deliver async replies to canonical main", async () => {
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
  await until(
    async () =>
      Object.keys((await harness.snapshot(OrchestrationDoc, context))!.workers).length === 2,
  );
  await until(async () => (await orchestration.listRunning()).length === 0);
  await main.waitForIdle(context);
  const state = (await harness.snapshot(OrchestrationDoc, context))!;
  expect(Object.values(state.workers).some((w) => w.parentId !== main.id)).toBe(true);
  const mainHistory = JSON.stringify((await main.context(context)).messages);
  expect(mainHistory).toContain("leaf answer");
  const outer = Object.values(state.workers).find((w) => w.parentId === main.id)!;
  const outerHistory = JSON.stringify(
    (await (await harness.conversation(outer.id, context))!.context(context)).messages,
  );
  expect(outerHistory).not.toContain("leaf answer");
}, 15000);

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
  const initial = Object.values((await harness.snapshot(OrchestrationDoc, context))!.workers)[0]!;
  workerId = String(initial.id);
  const firstTask = initial.active!;
  await (await main.submit({ type: "input", content: "queue next" }, context)).wait(context);
  const secondTask = (await harness.snapshot(OrchestrationDoc, context))!.workers[workerId]!
    .active!;
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
  const original = Object.values((await harness.snapshot(OrchestrationDoc, context))!.workers)[0]!;
  workerId = String(original.id);
  const firstTask = original.active!;
  try {
    await until(async () => seen.length === 1);
    await (await main.submit({ type: "input", content: "queue pair" }, context)).wait(context);
    const state = (await harness.snapshot(OrchestrationDoc, context))!;
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
  workerId = Object.keys((await harness.snapshot(OrchestrationDoc, context))!.workers)[0]!;
  await (await main.submit({ type: "input", content: "resume pair" }, context)).wait(context);
  expect(Object.keys((await harness.snapshot(OrchestrationDoc, context))!.calls)).toHaveLength(2);
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
  workerId = Object.keys((await harness.snapshot(OrchestrationDoc, context))!.workers)[0]!;
  await (await main.submit({ type: "input", content: "queue stoppable" }, context)).wait(context);
  await (await main.submit({ type: "input", content: "stop worker" }, context)).wait(context);
  await until(async () => (await orchestration.listRunning()).length === 0);
  const worker = (await harness.conversation(Number(workerId) as never, context))!;
  expect(JSON.stringify((await worker.context(context)).messages)).not.toContain(
    "queued worker must never start",
  );
  for (const call of Object.values((await harness.snapshot(OrchestrationDoc, context))!.calls)) {
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
  expect((await harness.snapshot(OrchestrationDoc, context))!.inlineContext).toBeUndefined();
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
  await until(
    async () =>
      Object.keys((await harness.snapshot(OrchestrationDoc, context))!.workers).length === 1,
  );
  const worker = Object.values((await harness.snapshot(OrchestrationDoc, context))!.workers)[0]!;
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
