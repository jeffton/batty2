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
import { Type } from "@earendil-works/pi-ai";
import {
  createRegistry,
  Harness,
  ProviderDoc,
  MemoryStorage,
  defineExtension,
  defineTool,
  type EntryRecord,
} from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { createMemory, fitView, projectEntry, utf8Bytes } from "./memory.js";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});

test("projection keeps tools and exact text but excludes reasoning", () => {
  const entry = {
    id: 9,
    conversationId: 1,
    kind: "pi.assistant",
    model: [
      {
        role: "assistant",
        timestamp: 1000,
        content: [
          { type: "thinking", thinking: "secret", thinkingSignature: "encrypted" },
          { type: "text", text: "Finding" },
          { type: "toolCall", name: "read", arguments: { path: "file" }, id: "call" },
        ],
      },
    ],
  } as unknown as EntryRecord;
  expect(projectEntry(entry)).toMatchObject([
    { kind: "talk", text: "Finding", source: 9, ordinal: 0 },
    { kind: "tool", text: 'read {"path":"file"}', source: 9, ordinal: 1 },
  ]);
  expect(JSON.stringify(projectEntry(entry))).not.toContain("secret");
  const imported = { ...entry, data: { provenance: { source: "roy" } } };
  expect(projectEntry(imported as EntryRecord)).toEqual([]);
});

test("fatal memory preparation aborts without dispatching raw canonical history", async () => {
  const models = createModels();
  const faux = fauxProvider();
  models.setProvider(faux.provider);
  let calls = 0;
  faux.setResponses([
    (request) => {
      calls++;
      return fauxAssistantMessage([fauxText(String(request.messages.length))]);
    },
  ]);
  const memory = createMemory(
    { memoryModel: "missing/model", nodeBytes: 1, onError: () => undefined },
    models,
  );
  const registry = createRegistry();
  registry.install(memory.extension);
  const harness = await Harness.open(
    new MemoryStorage(),
    { models, registry, settings: { compaction: { enabled: false } } },
    context,
  );
  const main = await harness.root(context, {
    agent: { model: { provider: "faux", modelId: "faux-1" } },
  });
  cleanup.push(async () => {
    await harness.close(context);
    await memory.close();
  });
  await main.commit(
    (tx) =>
      tx.appendEntry(main.id, {
        kind: "pi.user",
        model: [{ role: "user", content: "private original", timestamp: 1 }],
      }),
    context,
  );
  await memory.bind(harness, main);
  const settled = await (
    await main.submit({ type: "input", content: "new input" }, context)
  ).wait(context);
  expect(settled.status).toBe("unanswered");
  expect(calls).toBe(0);
  expect(memory.status().error).toContain("Memory model unavailable");
});

test("most-due sibling merge preserves a complete aligned cover and measures UTF8", () => {
  expect(utf8Bytes("æ🦾")).toBe(6);
  const parts = Array.from({ length: 8 }, (_, start) => ({ start, count: 1 }));
  const nodes = new Map(parts.map((part) => [`${part.start}+1`, "æ".repeat(10)]));
  for (let start = 0; start < 8; start += 2) nodes.set(`${start}+2`, "merged");
  const view = fitView(parts, 8, nodes, 150);
  expect(view[0]).toEqual({ start: 0, count: 2 });
  expect(view.reduce((sum, part) => sum + part.count, 0)).toBe(8);
  expect(parts).toHaveLength(8);
});

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "batty-memory-"));
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  const models = createModels();
  const faux = fauxProvider();
  models.setProvider(faux.provider);
  let compressions = 0;
  const open = async () => {
    const memory = createMemory(
      {
        nodeBytes: 80,
        viewBytes: 100,
        compress: async (source) => {
          compressions++;
          return `summary ${source.slice(0, 45)}`;
        },
      },
      models,
    );
    const registry = createRegistry();
    registry.install(memory.extension);
    const harness = await Harness.open(
      await openNodeSqliteStorage(join(directory, "runtime.sqlite")),
      { models, registry, settings: { compaction: { enabled: false } } },
      context,
    );
    const main = await harness.root(context, {
      agent: { model: { provider: "faux", modelId: "faux-1" } },
    });
    await memory.bind(harness, main);
    return { memory, harness, main, registry };
  };
  return { open, faux, models, compressions: () => compressions };
}

test("projection, immutable nodes and exact zoom survive reopen without resummarization", async () => {
  const fixtureState = await fixture();
  let state = await fixtureState.open();
  const exact = "æ".repeat(100);
  await state.main.commit(async (tx) => {
    for (let i = 0; i < 8; i++)
      await tx.appendEntry(state.main.id, {
        kind: "pi.user",
        model: [{ role: "user", content: `${i}:${exact}`, timestamp: i + 1 }],
      });
  }, context);
  const first = await state.memory.prepare();
  expect(first).not.toContain("not summarized");
  expect(first).toContain("summary");
  expect(await state.memory.zoom(0, 1)).toBe(`0+0|user: 0:${exact}`);
  expect(await state.memory.date(0)).toBe("1970-01-01T00:00:00.001Z");
  const calls = fixtureState.compressions();
  await state.harness.close(context);
  state = await fixtureState.open();
  cleanup.push(() => state.harness.close(context));
  expect(await state.memory.prepare()).toBe(first);
  expect(fixtureState.compressions()).toBe(calls);
  expect(await state.memory.zoom(0, 2)).toContain("1+1|");
  await expect(state.memory.zoom(1, 2)).rejects.toThrow("No line");
});

test("each run starts from a persisted view and the full new input, never old raw turns", async () => {
  const fixtureState = await fixture();
  const state = await fixtureState.open();
  cleanup.push(() => state.harness.close(context));
  const requests: unknown[] = [];
  fixtureState.faux.setResponses([
    (request) => {
      requests.push(request.messages);
      return fauxAssistantMessage([fauxText("old exact reply")]);
    },
    (request) => {
      requests.push(request.messages);
      return fauxAssistantMessage([fauxText("new reply")]);
    },
  ]);
  await (
    await state.main.submit({ type: "input", content: "first", requestId: "first" }, context)
  ).wait(context);
  await (
    await state.main.submit({ type: "input", content: "second", requestId: "second" }, context)
  ).wait(context);
  const second = requests[1] as { role: string; content: unknown }[];
  expect(second.some((message) => message.role === "assistant")).toBe(false);
  expect(JSON.stringify(second)).toContain("old exact reply");
  expect(JSON.stringify(second)).toContain("batty-optchat:");
  expect(JSON.stringify(second)).toContain("second");
  const provider = (await state.harness.snapshot(ProviderDoc, state.main.id, context))!;
  expect(() =>
    state.memory.validateRequest(
      { messages: [{ role: "user", content: "raw canonical", timestamp: 0 }] },
      { sessionId: provider.sessionId },
    ),
  ).toThrow("no persisted OptChat");
});

test("a run's tool loop preserves reasoning signatures and its frozen view verbatim", async () => {
  const fixtureState = await fixture();
  const state = await fixtureState.open();
  cleanup.push(() => state.harness.close(context));
  state.registry.install(
    defineExtension({
      name: "test-tools",
      tools: [
        defineTool({
          name: "check",
          description: "check",
          parameters: Type.Object({}),
          replay: "safe",
          execute: async () => ({ content: [{ type: "text", text: "exact tool output" }] }),
        }),
      ],
    }),
  );
  await state.main.commit(
    (tx) =>
      tx.appendEntry(state.main.id, {
        kind: "pi.user",
        model: [{ role: "user", content: "archived input", timestamp: 1 }],
      }),
    context,
  );
  const requests: { role: string; content: unknown }[][] = [];
  let copied: readonly { role: string; content: unknown }[] = [];
  fixtureState.faux.setResponses([
    (request) => {
      requests.push(request.messages);
      return fauxAssistantMessage(
        [
          { type: "thinking", thinking: "opaque thought", thinkingSignature: "encrypted-exact" },
          fauxToolCall("check", {}),
        ],
        { stopReason: "toolUse" },
      );
    },
    async (request) => {
      requests.push(request.messages);
      copied = await state.memory.contextFor(state.main.id, true);
      return fauxAssistantMessage([fauxText("done")]);
    },
  ]);
  const originalStream = fixtureState.models.streamSimple.bind(fixtureState.models);
  fixtureState.models.streamSimple = (model, request, options) => {
    state.memory.validateRequest(request, options);
    return originalStream(model, request, options);
  };
  const settled = await (
    await state.main.submit({ type: "input", content: "use check" }, context)
  ).wait(context);
  expect(settled.status).toBe("done");
  expect(requests).toHaveLength(2);
  expect(JSON.stringify(requests[1])).toContain("encrypted-exact");
  expect(JSON.stringify(requests[1])).toContain("exact tool output");
  const packet = (request: { role: string; content: unknown }[]) =>
    request.find(
      (message) => message.role === "user" && String(message.content).includes("batty-optchat:"),
    )!.content;
  expect(packet(requests[0]!)).toEqual(packet(requests[1]!));
  expect(copied.filter((message) => message.role !== "system")).toEqual(
    requests[1]!.filter((message) => message.role !== "system"),
  );
  expect(
    copied.some((message) => message.role === "user" && message.content === "archived input"),
  ).toBe(false);
  expect(
    (await state.main.context(context)).messages.some(
      (message) => message.role === "user" && message.content === "archived input",
    ),
  ).toBe(false);
  expect(
    (await state.main.entries({}, 100, undefined, context)).items.some((entry) =>
      entry.model?.some(
        (message) => message.role === "user" && message.content === "archived input",
      ),
    ),
  ).toBe(true);
  const idle = await state.memory.contextFor(state.main.id, true);
  expect(idle).toHaveLength(1);
  expect(idle[0]!.role).toBe("user");
  expect(await state.memory.contextFor(state.main.id, false)).toEqual([]);
  const child = await state.harness.createConversation(
    { ownership: { kind: "ownerless" } },
    context,
  );
  await child.commit(
    (tx) =>
      tx.appendEntry(child.id, {
        kind: "pi.user",
        model: [{ role: "user", content: "worker input", timestamp: 1 }],
      }),
    context,
  );
  expect(await state.memory.contextFor(child.id, true)).toEqual(
    (await child.context(context)).messages,
  );
});
