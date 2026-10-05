import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vite-plus/test";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import {
  fauxProvider,
  fauxAssistantMessage,
  fauxToolCall,
  fauxText,
} from "@earendil-works/pi-ai/providers/faux";
import { createRegistry, Harness, MemoryStorage } from "@earendil-works/pi-durable";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { createMemory, MemoryIndexDoc } from "./memory";
import { createTools } from "./tools";
import { createOrchestration, OrchestrationDoc } from "./orchestration";

async function until(check: () => Promise<boolean>) {
  for (let i = 0; i < 1000; i++) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("Worker did not finish");
}

test.each(["fresh", "nested", "cron"])(
  "%s worker fetches main catalog and zooms through codemode without inherited history",
  async (kind) => {
    const directory = await mkdtemp(join(tmpdir(), "batty-overview-"));
    const models = createModels();
    const faux = fauxProvider({ tokensPerSecond: 100_000 });
    models.setProvider(faux.provider);
    const memory = createMemory(
      {
        nodeBytes: 80,
        viewBytes: 100,
        compress: async () => {
          return "user: archived decision about the secret";
        },
      },
      models,
    );
    const tools = await createTools({ battyDir: directory, workspacesRoots: [directory] } as any);
    const orchestration = createOrchestration({
      workspaces: [
        {
          id: "test",
          path: directory,
          label: "Test",
          kind: "workspace",
          isPinned: false,
          isAssistant: false,
        },
      ],
    });
    const registry = createRegistry();
    registry.install(tools.extension);
    registry.install(orchestration.extension);
    registry.install(memory.extension);
    const harness = await Harness.open(
      new MemoryStorage(),
      { models, registry, env: () => new NodeExecutionEnv({ cwd: directory }) },
      context,
    );
    const main = await harness.root(context, {
      agent: { cwd: directory, model: { provider: "faux", modelId: "faux-1" } },
    });
    try {
      tools.bindHarness(harness);
      tools.registerTools([
        ...(memory.extension.tools ?? []),
        ...(orchestration.extension.tools ?? []),
      ]);
      orchestration.setContextProvider((id, mode) => memory.contextFor(id, mode));
      await orchestration.bind(harness, main);
      await memory.bind(harness, main);
      const secret = "exact archived decision " + "x".repeat(200);
      await main.commit(async (tx) => {
        for (let i = 0; i < 8; i++)
          await tx.appendEntry(main.id, {
            kind: "pi.user",
            model: [{ role: "user", content: `${i}:${secret}`, timestamp: i + 1 }],
          });
      }, context);
      await memory.prepare();
      const inspected: number[] = [];
      let navigated = 0;
      const code = `const overview = await tools.memory_overview({});
text(overview);
const line = overview.match(/(\\d+)\\+(\\d+)\\|/);
let id = Number(line[1]), n = Number(line[2]);
while (n > 1) { text(await tools.zoom({id, n})); n /= 2; }
text(await tools.zoom({id, n: 1}));
text(await tools.date({id}));`;
      faux.setResponses(
        Array.from({ length: 40 }, () => (request) => {
          const last = request.messages.findLast((m) => m.role !== "system")!;
          if (last.role === "user") {
            const input = JSON.stringify(last.content);
            if (input.includes("launch catalog"))
              return fauxAssistantMessage(
                [
                  fauxToolCall("subagent", {
                    action: "run",
                    prompt: kind === "nested" ? "launch nested catalog" : "inspect catalog",
                    async: true,
                  }),
                ],
                { stopReason: "toolUse" },
              );
            if (input.includes("launch nested catalog"))
              return fauxAssistantMessage(
                [
                  fauxToolCall("subagent", {
                    action: "run",
                    prompt: "inspect catalog",
                    async: true,
                  }),
                ],
                { stopReason: "toolUse" },
              );
            if (input.includes("inspect catalog")) {
              expect(JSON.stringify(request.messages)).not.toContain(secret);
              expect(
                JSON.stringify(request.messages.filter((message) => message.role !== "system")),
              ).not.toContain("<chat>");
              inspected.push(request.messages.length);
              return fauxAssistantMessage([fauxToolCall("codemode", { code })], {
                stopReason: "toolUse",
              });
            }
          }
          if (last.role === "toolResult" && last.toolName === "codemode") {
            const output = JSON.stringify(last.content);
            expect(last.isError).toBeFalsy();
            expect(output).toContain(`Main memory (OptChat overview)`);
            expect(output).toContain("user: archived decision about the secret");
            expect(output).toContain(`0:${secret}`);
            expect(output).toContain("1970-01-01T00:00:00.001Z");
            navigated++;
          }
          return fauxAssistantMessage([fauxText("NO_REPLY")]);
        }),
      );
      if (kind === "cron") {
        const job = await orchestration.addJob({
          workspaceId: "test",
          prompt: "inspect catalog",
          session: { kind: "main-detached" },
          schedule: { kind: "at", in: "1h" },
        });
        await main.commit(async (tx) => {
          (await tx.doc(OrchestrationDoc)).jobs[job.id]!.nextAt = Date.now() - 1;
        }, context);
        await orchestration.tick();
        await until(async () => (await orchestration.listRunningCron()).length === 0);
        expect((await orchestration.listRunLogs(job.id))[0]?.status).toBe("completed");
      } else {
        await (
          await main.submit({ type: "input", content: "launch catalog" }, context)
        ).wait(context);
        await until(async () => (await orchestration.listRunning()).length === 0);
      }
      expect(inspected).toHaveLength(1);
      expect(navigated).toBe(1);
    } finally {
      orchestration.close();
      await harness.close(context);
      await memory.close();
      await tools.close();
      await rm(directory, { recursive: true, force: true });
    }
  },
  15000,
);

test("overview reads the built catalog without waiting for or starting pending compression", async () => {
  const models = createModels();
  const faux = fauxProvider();
  models.setProvider(faux.provider);
  let unblock!: () => void;
  let started!: () => void;
  const blocked = new Promise<void>((resolve) => {
    unblock = resolve;
  });
  const entered = new Promise<void>((resolve) => {
    started = resolve;
  });
  let compressions = 0;
  const memory = createMemory(
    {
      nodeBytes: 80,
      compress: async () => {
        compressions++;
        started();
        await blocked;
        return "user: pending summary";
      },
    },
    models,
  );
  const registry = createRegistry();
  registry.install(memory.extension);
  const harness = await Harness.open(new MemoryStorage(), { models, registry }, context);
  const main = await harness.root(context, {
    agent: { model: { provider: "faux", modelId: "faux-1" } },
  });
  let settling: Promise<string> | undefined;
  try {
    await memory.bind(harness, main);
    await main.commit(
      (tx) =>
        tx.appendEntry(main.id, {
          kind: "pi.user",
          model: [{ role: "user", content: "built decision", timestamp: 1 }],
        }),
      context,
    );
    const built = await memory.prepare();
    await main.commit(
      (tx) =>
        tx.appendEntry(main.id, {
          kind: "pi.user",
          model: [{ role: "user", content: "pending ".repeat(100), timestamp: 2 }],
        }),
      context,
    );
    await memory.sync();
    settling = memory.settle();
    await entered;
    const before = await harness.snapshot(MemoryIndexDoc, main.id, context);
    const worker = await harness.createConversation({ ownership: { kind: "ownerless" } }, context);
    let overview = "";
    faux.setResponses([
      fauxAssistantMessage([fauxToolCall("memory_overview", {})], { stopReason: "toolUse" }),
      (request) => {
        const result = request.messages.findLast((message) => message.role === "toolResult")!;
        overview = JSON.stringify(result.content);
        return fauxAssistantMessage([fauxText("done")]);
      },
    ]);
    await worker.configure({ model: { provider: "faux", modelId: "faux-1" } }, context);
    expect(
      (
        await (
          await worker.submit({ type: "input", content: "fetch catalog" }, context)
        ).wait(context)
      ).status,
    ).toBe("done");
    expect(overview).toContain(built.replaceAll("\n", "\\n"));
    expect(overview).not.toContain("pending summary");
    expect(compressions).toBe(1);
    expect(await harness.snapshot(MemoryIndexDoc, main.id, context)).toEqual(before);
    expect(await memory.zoom(0, 1)).toBe("0+0|user: built decision");
    expect(await memory.date(0)).toBe("1970-01-01T00:00:00.001Z");
  } finally {
    unblock();
    await settling;
    await harness.close(context);
    await memory.close();
  }
}, 15000);
