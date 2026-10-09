import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vite-plus/test";
import { BACKGROUND_CONTEXT as context, withCancel } from "@earendil-works/chord/context";
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
  defineDoc,
  defineTool,
  type EntryRecord,
} from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import {
  createMemory,
  fitView,
  projectEntry,
  utf8Bytes,
  MemoryNodesDoc,
  MemoryMaintenanceDoc,
  MemoryIndexDoc,
  type MemoryConfig,
} from "./memory.js";

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
  const storage = new MemoryStorage();
  const harness = await Harness.open(
    storage,
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
  await memory.bind(harness, main, storage);
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

test("view batches trigger strictly above the limit and preserve the prefix between batches", () => {
  const parts = Array.from({ length: 8 }, (_, start) => ({ start, count: 1 }));
  const nodes = new Map(parts.map((part) => [`${part.start}+1`, "x".repeat(16_000)]));
  for (let count = 2; count <= 8; count *= 2)
    for (let start = 0; start < 8; start += count) nodes.set(`${start}+${count}`, "m".repeat(512));
  expect(fitView(parts, 8, nodes)).toEqual(parts); // Exactly 128,000 bytes.
  nodes.set("7+1", "x".repeat(16_001));
  const fitted = fitView(parts, 8, nodes);
  const bytes = fitted.reduce(
    (sum, part) => sum + utf8Bytes(nodes.get(`${part.start}+${part.count}`)!),
    0,
  );
  expect(bytes).toBeLessThanOrEqual(64_000);
  nodes.set("8+1", "next message");
  const appended = [...fitted, { start: 8, count: 1 }];
  expect(fitView(appended, 9, nodes)).toEqual(appended);
});

test("an unfinished batch resumes below the trigger when its parents become available", () => {
  const parts = Array.from({ length: 8 }, (_, start) => ({ start, count: 1 }));
  const nodes = new Map(parts.map((part) => [`${part.start}+1`, "x".repeat(20)]));
  nodes.set("0+2", "m");
  const batch = {};
  const partial = fitView(parts, 8, nodes, 150, batch);
  expect(partial).toHaveLength(7); // 121 bytes: below trigger, above 75-byte target.
  expect(batch).toEqual({ merging: true });
  // Persisted state survives a restart, without requiring the original parts.
  const resumedBatch = JSON.parse(JSON.stringify(batch));
  for (let start = 2; start < 8; start += 2) nodes.set(`${start}+2`, "m");
  const resumed = fitView(partial, 8, nodes, 150, resumedBatch);
  expect(
    resumed.reduce((sum, part) => sum + utf8Bytes(nodes.get(`${part.start}+${part.count}`)!), 0),
  ).toBeLessThanOrEqual(75);
  expect(resumedBatch.merging).toBe(false);
});

test("merge age is normalized by line size, with oldest-first ties", () => {
  const parts = [
    { start: 0, count: 4 },
    { start: 4, count: 4 },
    { start: 8, count: 4 },
    { start: 12, count: 1 },
    { start: 13, count: 1 },
  ];
  const nodes = new Map(parts.map((part) => [`${part.start}+${part.count}`, "x".repeat(40)]));
  nodes.set("0+8", "m");
  nodes.set("12+2", "m");
  // At T=16 both pairs are two line-sizes old; the older pair wins the tie.
  expect(fitView(parts, 16, nodes, 330, { merging: true })).toEqual([
    { start: 0, count: 8 },
    ...parts.slice(2),
  ]);
});

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "batty-memory-"));
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  const models = createModels();
  const faux = fauxProvider();
  models.setProvider(faux.provider);
  let compressions = 0;
  const open = async (options: Partial<MemoryConfig> = {}) => {
    const memory = createMemory(
      {
        nodeBytes: 80,
        viewBytes: 100,
        compress: async (source) => {
          compressions++;
          return `summary ${source.slice(0, 30)}`;
        },
        ...options,
      },
      models,
    );
    const registry = createRegistry();
    registry.install(memory.extension);
    const storage = await openNodeSqliteStorage(join(directory, "runtime.sqlite"));
    const harness = await Harness.open(
      storage,
      { models, registry, settings: { compaction: { enabled: false } } },
      context,
    );
    const main = await harness.root(context, {
      agent: { model: { provider: "faux", modelId: "faux-1" } },
    });
    await memory.bind(harness, main, storage);
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

test("SQLite reopening preserves an unfinished batch and completes it on new input", async () => {
  const f = await fixture();
  const options = { nodeBytes: 64, viewBytes: 300, compress: async () => "summary" };
  let state = await f.open(options);
  await state.main.commit(async (tx) => {
    for (let i = 0; i < 8; i++)
      await tx.appendEntry(state.main.id, {
        kind: "pi.user",
        model: [{ role: "user", content: "x".repeat(40), timestamp: i + 1 }],
      });
  }, context);
  await state.memory.prepare();
  await state.main.commit(async (tx) => {
    const draft = await tx.doc(MemoryIndexDoc, state.main.id);
    // A partial batch is below 300 bytes but still above its 150-byte target.
    draft.parts = [
      { start: 0, count: 4 },
      ...Array.from({ length: 4 }, (_, i) => ({ start: i + 4, count: 1 })),
    ];
    draft.merging = true;
  }, context);
  await state.memory.close();
  await state.harness.close(context);
  state = await f.open(options);
  cleanup.push(async () => {
    await state.memory.close();
    await state.harness.close(context);
  });
  expect((await state.harness.snapshot(MemoryIndexDoc, state.main.id, context))?.merging).toBe(
    true,
  );
  await state.main.commit(
    (tx) =>
      tx.appendEntry(state.main.id, {
        kind: "pi.user",
        model: [{ role: "user", content: "new", timestamp: 9 }],
      }),
    context,
  );
  await state.memory.prepare();
  const index = (await state.harness.snapshot(MemoryIndexDoc, state.main.id, context))!;
  expect(index.merging).toBe(false);
  const texts = await Promise.all(
    index.parts.map((part) =>
      state.harness.snapshot(MemoryNodesDoc, state.main.id, `${part.start}+${part.count}`, context),
    ),
  );
  expect(texts.reduce((sum, node) => sum + utf8Bytes(node!.text), 0)).toBeLessThanOrEqual(150);
  expect(await state.memory.zoom(0, 1)).toContain("x".repeat(40));
});

test("silent old and future turns keep IDs and originals but leave prepared memory", async () => {
  const fixtureState = await fixture();
  let state = await fixtureState.open();
  await state.main.commit(async (tx) => {
    await tx.appendEntry(state.main.id, {
      kind: "pi.assistant",
      model: [fauxAssistantMessage([fauxText("NO_REPLY")])],
    });
    await tx.appendEntry(state.main.id, {
      kind: "pi.user",
      model: [{ role: "user", content: "keep useful decision", timestamp: 123 }],
    });
  }, context);
  expect(await state.memory.prepare()).not.toContain("NO_REPLY");
  const original = await state.memory.zoom(0, 1);
  const originalDate = await state.memory.date(0);
  const sourceEntries = (await state.main.entries({}, 100, undefined, context)).items;
  await state.main.commit(async (tx) => {
    // Simulate a legacy tree created before the persistent maintenance checkpoint.
    await tx.retireDoc(MemoryMaintenanceDoc, state.main.id);
    (await tx.doc(MemoryNodesDoc, state.main.id, "0+1", { text: "" })).text = "talk: NO_REPLY";
    (await tx.doc(MemoryNodesDoc, state.main.id, "0+2", { text: "" })).text =
      "talk: NO_REPLY; user: useful";
  }, context);
  const calls = fixtureState.compressions();
  await state.memory.close();
  await state.harness.close(context);
  state = await fixtureState.open();
  cleanup.push(async () => {
    await state.memory.close();
    await state.harness.close(context);
  });
  expect(await state.memory.prepare()).not.toContain("NO_REPLY");
  expect(fixtureState.compressions()).toBe(calls);
  expect(await state.memory.zoom(0, 1)).toBe(original);
  expect(await state.memory.date(0)).toBe(originalDate);
  expect(await state.memory.zoom(1, 1)).toContain("keep useful decision");
  expect((await state.main.entries({}, 100, undefined, context)).items).toEqual(sourceEntries);
  expect((await state.memory.browserNode(0, 2)).children[0]?.summary).toContain("noise excluded");
  expect((await state.memory.browserNode(0, 1)).text).toContain("NO_REPLY");
  await state.main.commit(
    (tx) =>
      tx.appendEntry(state.main.id, {
        kind: "pi.assistant",
        model: [fauxAssistantMessage([fauxText("NO_REPLY")])],
      }),
    context,
  );
  expect(await state.memory.prepare()).not.toContain("NO_REPLY");
  expect(await state.memory.zoom(2, 1)).toContain("NO_REPLY");
  expect(await state.memory.zoom(1, 1)).toContain("keep useful decision");
});

test("full rebuild derives a fresh generation only from originals, preserves IDs and catches up tail", async () => {
  const f = await fixture();
  const state = await f.open();
  cleanup.push(async () => {
    await state.memory.close();
    await state.harness.close(context);
  });
  await state.main.commit(async (tx) => {
    await tx.appendEntry(state.main.id, {
      kind: "pi.assistant",
      model: [fauxAssistantMessage([fauxText("NO_REPLY")])],
    });
    for (let i = 0; i < 3; i++)
      await tx.appendEntry(state.main.id, {
        kind: "pi.user",
        model: [{ role: "user", content: `source ${i} ${"x".repeat(120)}`, timestamp: i + 1 }],
      });
  }, context);
  await state.memory.prepare();
  const exact = await state.memory.zoom(1, 1);
  await state.main.commit(async (tx) => {
    (await tx.doc(MemoryNodesDoc, state.main.id, "1+1", { text: "" })).text = "CONTAMINATED";
    (await tx.doc(MemoryNodesDoc, state.main.id, "0+4", { text: "" })).text = "CONTAMINATED";
  }, context);
  await state.memory.rebuild();
  expect(await state.memory.prepare()).not.toContain("CONTAMINATED");
  expect(await state.memory.zoom(1, 1)).toBe(exact);
  expect(await state.memory.zoom(0, 1)).toContain("NO_REPLY");
  expect(await state.memory.prepare()).not.toContain("NO_REPLY");
  expect(
    (await state.harness.snapshot(MemoryNodesDoc, state.main.id, "g1:1+1", context))?.text,
  ).toContain("source 0");
  // The old generation is retained, rather than destructively edited by rebuild.
  expect((await state.harness.snapshot(MemoryNodesDoc, state.main.id, "1+1", context))?.text).toBe(
    "CONTAMINATED",
  );
  const calls = f.compressions();
  await state.memory.rebuild();
  expect(f.compressions()).toBe(calls);
  await state.main.commit(
    (tx) =>
      tx.appendEntry(state.main.id, {
        kind: "pi.user",
        model: [{ role: "user", content: "new decision", timestamp: 42 }],
      }),
    context,
  );
  await state.memory.prepare();
  expect(await state.memory.zoom(4, 1)).toContain("new decision");
  expect(
    (await state.harness.snapshot(MemoryNodesDoc, state.main.id, "g1:4+1", context))?.text,
  ).toContain("new decision");
});

test("resume honors persisted repairs while accepting complete oversized candidates", async () => {
  const f = await fixture();
  let state = await f.open({
    compress: async (source) =>
      source.includes("valid child") ? "ø".repeat(41) : `repaired child ${"x".repeat(60)}`,
  });
  cleanup.push(async () => {
    await state.memory.close();
    await state.harness.close(context);
  });
  await state.main.commit(async (tx) => {
    for (let i = 0; i < 2; i++)
      await tx.appendEntry(state.main.id, {
        kind: "pi.user",
        model: [{ role: "user", content: `decision ${i} ${"x".repeat(100)}`, timestamp: i }],
      });
  }, context);
  await state.memory.prepare();
  const original = await state.memory.zoom(0, 1);
  const rebuild = defineDoc<{
    generation: number;
    total: number;
    status: "pending" | "complete";
    level?: number;
    repairs?: string[];
  }>({
    kind: "batty.memory-rebuild",
    version: 1,
    scope: "conversation",
    history: "latest",
    fork: "initial",
    initial: () => ({ generation: 0, total: 0, status: "complete" }),
  });
  await state.main.commit(async (tx) => {
    Object.assign(await tx.doc(rebuild, state.main.id), {
      generation: 1,
      total: 2,
      status: "pending",
      level: 4,
      repairs: ["0+1", "0+2"],
    });
    (await tx.doc(MemoryNodesDoc, state.main.id, "g1:0+1", { text: "" })).text = "ø".repeat(50);
    (await tx.doc(MemoryNodesDoc, state.main.id, "g1:1+1", { text: "" })).text = "valid child";
    (await tx.doc(MemoryNodesDoc, state.main.id, "g1:0+2", { text: "" })).text = "STALE PARENT";
  }, context);
  await state.memory.rebuild();
  expect(
    (await state.harness.snapshot(MemoryNodesDoc, state.main.id, "g1:0+1", context))?.text,
  ).toBe(`repaired child ${"x".repeat(60)}`);
  expect((await state.harness.snapshot(MemoryIndexDoc, state.main.id, context))?.generation).toBe(
    1,
  );
  await state.memory.close();
  await state.harness.close(context);
  state = await f.open();
  await state.memory.rebuild();
  expect((await state.harness.snapshot(MemoryIndexDoc, state.main.id, context))?.generation).toBe(
    1,
  );
  for (const key of ["g1:0+1", "g1:1+1", "g1:0+2"]) {
    const node = await state.harness.snapshot(MemoryNodesDoc, state.main.id, key, context);
    expect(node!.text).not.toContain("STALE PARENT");
  }
  expect(await state.memory.zoom(0, 1)).toBe(original);
});

test("oversize custom compression completes rebuild and publishes the shortest complete candidate", async () => {
  const f = await fixture();
  let fail = false;
  const state = await f.open({ compress: async () => (fail ? "ø".repeat(41) : "valid summary") });
  cleanup.push(async () => {
    await state.memory.close();
    await state.harness.close(context);
  });
  await state.main.commit(
    (tx) =>
      tx.appendEntry(state.main.id, {
        kind: "pi.user",
        model: [{ role: "user", content: "source ".repeat(30), timestamp: 1 }],
      }),
    context,
  );
  await state.memory.prepare();
  fail = true;
  await state.memory.rebuild();
  expect((await state.harness.snapshot(MemoryIndexDoc, state.main.id, context))?.generation).toBe(
    1,
  );
  expect(
    (await state.harness.snapshot(MemoryNodesDoc, state.main.id, "g1:0+1", context))?.text,
  ).toBe("ø".repeat(41));
  fail = false;
  await state.memory.rebuild();
  expect((await state.harness.snapshot(MemoryIndexDoc, state.main.id, context))?.generation).toBe(
    1,
  );
});

test("generation publication includes originals admitted while rebuilding and survives reopen", async () => {
  const f = await fixture();
  let gated = false;
  let entered!: () => void;
  let release!: () => void;
  const ready = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let state = await f.open({
    compress: async (source) => {
      if (gated && source.startsWith("user: older")) {
        entered();
        await gate;
      }
      return `summary ${source.slice(0, 45)}`;
    },
  });
  await state.main.commit(
    (tx) =>
      tx.appendEntry(state.main.id, {
        kind: "pi.user",
        model: [{ role: "user", content: `older ${"x".repeat(120)}`, timestamp: 1 }],
      }),
    context,
  );
  await state.memory.prepare();
  const date = await state.memory.date(0);
  gated = true;
  const rebuilding = state.memory.rebuild();
  await ready;
  await state.main.commit(
    (tx) =>
      tx.appendEntry(state.main.id, {
        kind: "pi.user",
        model: [{ role: "user", content: "concurrent new decision", timestamp: 2 }],
      }),
    context,
  );
  // Live old generation remains usable and can admit new messages throughout.
  expect(await state.memory.prepare()).toContain("concurrent new decision");
  release();
  await rebuilding;
  expect(await state.memory.date(0)).toBe(date);
  expect(await state.memory.zoom(1, 1)).toContain("concurrent new decision");
  expect(
    (await state.harness.snapshot(MemoryNodesDoc, state.main.id, "g1:1+1", context))?.text,
  ).toContain("concurrent new decision");
  await state.memory.close();
  await state.harness.close(context);
  state = await f.open();
  cleanup.push(async () => {
    await state.memory.close();
    await state.harness.close(context);
  });
  expect(await state.memory.prepare()).toContain("concurrent new decision");
  expect(await state.memory.zoom(1, 1)).toContain("concurrent new decision");
  expect(await state.memory.date(0)).toBe(date);
});

test("interrupted rebuild resumes persisted fresh nodes without publishing a partial generation", async () => {
  const f = await fixture();
  let state = await f.open();
  await state.main.commit(async (tx) => {
    await tx.appendEntry(state.main.id, {
      kind: "pi.assistant",
      model: [fauxAssistantMessage([fauxText("NO_REPLY")])],
    });
    await tx.appendEntry(state.main.id, {
      kind: "pi.user",
      model: [{ role: "user", content: "x".repeat(200), timestamp: 1 }],
    });
  }, context);
  const before = await state.memory.prepare();
  await state.memory.close();
  await state.harness.close(context);
  let entered!: () => void;
  const enteredPromise = new Promise<void>((resolve) => {
    entered = resolve;
  });
  state = await f.open({
    compress: async (_, signal) => {
      entered();
      await new Promise((_, reject) =>
        signal!.addEventListener("abort", () => reject(signal!.reason), { once: true }),
      );
      return "unreachable";
    },
  });
  const pending = state.memory.rebuild().catch(() => undefined);
  await enteredPromise;
  expect(
    (await state.memory.browserOverview()).nodes.map((node) => node.summary).join("\n"),
  ).toContain("summary");
  await state.memory.close().catch(() => undefined);
  await pending;
  await state.harness.close(context);
  state = await f.open();
  cleanup.push(async () => {
    await state.memory.close();
    await state.harness.close(context);
  });
  expect(await state.memory.prepare()).toBe(before);
  await state.memory.rebuild();
  expect(
    (await state.harness.snapshot(MemoryNodesDoc, state.main.id, "g1:0+1", context))?.text,
  ).toBe("");
  expect(
    (await state.harness.snapshot(MemoryNodesDoc, state.main.id, "g1:1+1", context))?.text,
  ).toContain("summary");
  expect(await state.memory.zoom(1, 1)).toContain("x".repeat(200));
});

test("restart resumes an unfinished ancestor from durable children", async () => {
  const f = await fixture();
  const cancellation = withCancel(context);
  let state = await f.open({
    compress: async (_, signal) => {
      cancellation.cancel(new Error("interrupt parent"));
      signal!.throwIfAborted();
      return "unreachable";
    },
  });
  await state.main.commit(async (tx) => {
    for (let i = 0; i < 2; i++)
      await tx.appendEntry(state.main.id, {
        kind: "pi.user",
        model: [{ role: "user", content: `${i}:${"x".repeat(50)}`, timestamp: i + 1 }],
      });
  }, context);
  await expect(state.memory.prepare(cancellation.context)).rejects.toThrow("interrupt parent");
  expect(
    (await state.harness.snapshot(MemoryNodesDoc, state.main.id, "1+1", context))?.text,
  ).toContain("user: 1:");
  expect(
    await state.harness.snapshot(MemoryNodesDoc, state.main.id, "0+2", context),
  ).toBeUndefined();
  await state.memory.close();
  await state.harness.close(context);
  state = await f.open();
  cleanup.push(async () => {
    await state.memory.close();
    await state.harness.close(context);
  });
  await state.memory.prepare();
  expect(f.compressions()).toBe(1);
  expect(await state.memory.zoom(0, 2)).toContain("user: 1:");
  expect(state.memory.status().settled).toBe(2);
});

test("same-process retry publishes a final checkpoint cancelled after the last node", async () => {
  const f = await fixture();
  const cancellation = withCancel(context);
  let armed = false;
  const state = await f.open({
    onProgress: () => {
      if (armed) cancellation.cancel(new Error("cancel checkpoint"));
    },
  });
  cleanup.push(async () => {
    await state.memory.close();
    await state.harness.close(context);
  });
  await state.main.commit(
    (tx) =>
      tx.appendEntry(state.main.id, {
        kind: "pi.user",
        model: [{ role: "user", content: "decision after checkpoint", timestamp: 1 }],
      }),
    context,
  );
  armed = true;
  await expect(state.memory.prepare(cancellation.context)).rejects.toThrow("cancel checkpoint");
  // All nodes are built, but publishing their view still needs to be retried.
  expect(state.memory.status().pending).toBe(0);
  armed = false;
  expect(await state.memory.prepare()).toContain("decision after checkpoint");
  expect((await state.memory.browserOverview()).nodes[0]?.summary).toContain(
    "decision after checkpoint",
  );
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
  expect(JSON.stringify(second)).not.toContain("batty-optchat:");
  expect(second[0]!.role).toBe("system");
  expect(second[0]).toEqual((requests[0] as { role: string; content: unknown }[])[0]);
  expect(second.filter((message) => message.role === "system")).toHaveLength(1);
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
      (message) => message.role === "user" && String(message.content).startsWith("<chat>"),
    )!.content;
  expect(packet(requests[0]!)).toEqual(packet(requests[1]!));
  expect(requests[0]![0]!.role).toBe("system");
  expect(requests[0]![0]).toEqual(requests[1]![0]);
  for (const request of requests)
    expect(request.filter((message) => message.role === "system")).toHaveLength(1);
  expect(JSON.stringify(requests[0]![0])).toContain('"name":"check"');
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

test("selective repair stages ancestors atomically, preserves siblings and originals, and serializes new nodes", async () => {
  const f = await fixture();
  const sources: string[] = [];
  let entered!: () => void;
  let resume!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const blocked = new Promise<void>((resolve) => {
    resume = resolve;
  });
  const state = await f.open({
    nodeBytes: 512,
    compress: async (source) => {
      sources.push(source);
      if (sources.length === 1) {
        entered();
        await blocked;
      }
      return `user: Dansk reparation ${sources.length}`;
    },
  });
  cleanup.push(() => state.harness.close(context));
  await state.main.commit(async (tx) => {
    for (let i = 0; i < 8; i++)
      await tx.appendEntry(state.main.id, {
        kind: "pi.user",
        model: [{ role: "user", content: `Original ${i}`, timestamp: i + 1 }],
      });
  }, context);
  await state.memory.prepare();
  const node = (key: string) => state.harness.snapshot(MemoryNodesDoc, state.main.id, key, context);
  const sibling = await node("4+4");
  const original = await state.memory.zoom(0, 1);
  const plan = await state.memory.repair([{ start: 0, count: 2 }], 0, true);
  expect(plan.nodes).toEqual([
    { start: 0, count: 2 },
    { start: 0, count: 4 },
    { start: 0, count: 8 },
  ]);
  expect(sources).toEqual([]);
  const before = await node("0+2");
  const repairing = state.memory.repair([{ start: 0, count: 2 }], 0);
  await started;
  expect(await node("0+2")).toEqual(before);
  await state.main.commit(
    (tx) =>
      tx.appendEntry(state.main.id, {
        kind: "pi.user",
        model: [{ role: "user", content: "Ny original", timestamp: 20 }],
      }),
    context,
  );
  const preparing = state.memory.prepare();
  resume();
  const result = await repairing;
  await preparing;
  expect(result.nodes).toHaveLength(3);
  expect(sources[1]).toContain("Dansk reparation 1");
  expect(sources[2]).toContain("Dansk reparation 2");
  expect(await node("4+4")).toEqual(sibling);
  expect(await state.memory.zoom(0, 1)).toBe(original);
  expect(await state.memory.zoom(8, 1)).toContain("Ny original");
  expect(state.memory.status().totalLeaves).toBe(9);
  await expect(state.memory.repair([{ start: 1, count: 2 }], 0)).rejects.toThrow(
    "Invalid repair root",
  );
  await expect(state.memory.repair([{ start: 0, count: 2 }], 1)).rejects.toThrow(
    "generation changed",
  );
});

test("selective repair refuses concurrent edits without publishing partial ancestors", async () => {
  const f = await fixture();
  let entered!: () => void;
  let resume!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const blocked = new Promise<void>((resolve) => {
    resume = resolve;
  });
  const state = await f.open({
    nodeBytes: 512,
    compress: async () => {
      entered();
      await blocked;
      return "user: Dansk reparation";
    },
  });
  cleanup.push(() => state.harness.close(context));
  await state.main.commit(async (tx) => {
    for (let i = 0; i < 4; i++)
      await tx.appendEntry(state.main.id, {
        kind: "pi.user",
        model: [{ role: "user", content: `Original ${i}`, timestamp: i + 1 }],
      });
  }, context);
  await state.memory.prepare();
  const before = await state.harness.snapshot(MemoryNodesDoc, state.main.id, "0+4", context);
  const repair = state.memory.repair([{ start: 0, count: 2 }], 0);
  await started;
  await state.main.commit(async (tx) => {
    (await tx.doc(MemoryNodesDoc, state.main.id, "0+2", { text: "" })).text = "Concurrent edit";
  }, context);
  resume();
  await expect(repair).rejects.toThrow("Memory node changed during repair");
  expect(await state.harness.snapshot(MemoryNodesDoc, state.main.id, "0+4", context)).toEqual(
    before,
  );
  expect((await state.harness.snapshot(MemoryNodesDoc, state.main.id, "0+2", context))?.text).toBe(
    "Concurrent edit",
  );
});

test("generation-two repair deduplicates overlapping roots without touching older generations", async () => {
  const f = await fixture();
  let state = await f.open({ nodeBytes: 512 });
  await state.main.commit(async (tx) => {
    for (let i = 0; i < 8; i++)
      await tx.appendEntry(state.main.id, {
        kind: "pi.user",
        model: [{ role: "user", content: `Original ${i}`, timestamp: i + 1 }],
      });
  }, context);
  await state.memory.prepare();
  const originals = await Promise.all(
    Array.from({ length: 8 }, (_, id) => state.memory.zoom(id, 1)),
  );
  const old = await state.harness.snapshot(MemoryNodesDoc, state.main.id, "0+8", context);
  const copies: { key: string; text: string }[] = [];
  for (let count = 1; count <= 8; count *= 2)
    for (let start = 0; start + count <= 8; start += count)
      copies.push({
        key: `g2:${start}+${count}`,
        text: (await state.harness.snapshot(
          MemoryNodesDoc,
          state.main.id,
          `${start}+${count}`,
          context,
        ))!.text,
      });
  await state.main.commit(async (tx) => {
    for (const { key, text } of copies) await tx.doc(MemoryNodesDoc, state.main.id, key, { text });
    (await tx.doc(MemoryIndexDoc, state.main.id)).generation = 2;
    (await tx.doc(MemoryMaintenanceDoc, state.main.id)).generation = 2;
  }, context);
  await state.harness.close(context);
  state = await f.open({ nodeBytes: 512, compress: async () => "user: Dansk reparation" });
  cleanup.push(() => state.harness.close(context));
  const sibling = await state.harness.snapshot(MemoryNodesDoc, state.main.id, "g2:0+4", context);
  const repaired = await state.memory.repair(
    [
      { start: 6, count: 2 },
      { start: 4, count: 4 },
    ],
    2,
  );
  expect(repaired.nodes.map(({ start, count }) => `${start}+${count}`)).toEqual([
    "6+2",
    "4+4",
    "0+8",
  ]);
  expect(await state.harness.snapshot(MemoryNodesDoc, state.main.id, "g2:0+4", context)).toEqual(
    sibling,
  );
  expect(await state.harness.snapshot(MemoryNodesDoc, state.main.id, "0+8", context)).toEqual(old);
  expect(await Promise.all(Array.from({ length: 8 }, (_, id) => state.memory.zoom(id, 1)))).toEqual(
    originals,
  );
});

test("language repair explicitly translates inherited foreign prose without changing originals", async () => {
  const f = await fixture();
  const state = await f.open({ nodeBytes: 512, compress: undefined, memoryModel: "faux/faux-1" });
  cleanup.push(() => state.harness.close(context));
  await state.main.commit(async (tx) => {
    for (let i = 0; i < 2; i++)
      await tx.appendEntry(state.main.id, {
        kind: "pi.user",
        model: [{ role: "user", content: "Valde altan; resten uppskjutet.", timestamp: i + 1 }],
      });
  }, context);
  await state.memory.prepare();
  f.faux.setResponses([
    (request) => {
      expect(JSON.stringify(request.messages)).toContain(
        "Translate ALL unquoted summary prose into Danish",
      );
      expect(JSON.stringify(request.messages)).toContain("Valde altan; resten uppskjutet.");
      return fauxAssistantMessage([fauxText("user: Valgte altan; resten udskudt.")]);
    },
  ]);
  await state.memory.repair([{ start: 0, count: 2 }], 0);
  expect((await state.harness.snapshot(MemoryNodesDoc, state.main.id, "0+2", context))?.text).toBe(
    "user: Valgte altan; resten udskudt.",
  );
  expect(await state.memory.zoom(0, 1)).toContain("Valde altan; resten uppskjutet.");
});
