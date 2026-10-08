import { expect, test } from "vite-plus/test";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxText } from "@earendil-works/pi-ai/providers/faux";
import { createRegistry, Harness, MemoryStorage } from "@earendil-works/pi-durable";
import { createMemory, MemoryNodesDoc } from "./memory";

test("five oversize model responses fail visibly without truncating or persisting; retry resumes", async () => {
  const models = createModels();
  models.setProvider(fauxProvider().provider);
  let calls = 0;
  let valid = false;
  const corrections: string[] = [];
  models.completeSimple = async (_, request) => {
    calls++;
    corrections.push(JSON.stringify(request.messages));
    return fauxAssistantMessage([fauxText(valid ? "Bevar beslutningen." : "ø".repeat(257))]);
  };
  const memory = createMemory({ memoryModel: "faux/faux-1", onError: () => {} }, models);
  const registry = createRegistry();
  registry.install(memory.extension);
  const storage = new MemoryStorage();
  const harness = await Harness.open(storage, { models, registry }, context);
  const main = await harness.root(context, {
    agent: { model: { provider: "faux", modelId: "faux-1" } },
  });
  try {
    await memory.bind(harness, main, storage);
    await main.commit(
      (tx) =>
        tx.appendEntry(main.id, {
          kind: "pi.user",
          model: [{ role: "user", content: "Kildetekst ".repeat(100), timestamp: 1 }],
        }),
      context,
    );
    await expect(memory.prepare()).rejects.toThrow("after five attempts");
    expect(calls).toBe(5);
    expect(await harness.snapshot(MemoryNodesDoc, main.id, "0+1", context)).toBeUndefined();
    expect(corrections[0]).toContain("-".repeat(512));
    expect(corrections[4]).toContain("-".repeat(162));
    expect(corrections[4]).toContain("162 UTF-8 bytes");
    expect(corrections[4]).toContain("retaining its languages");
    expect(corrections[4]).not.toContain("ø".repeat(257));
    expect(corrections[4]).not.toContain("← LIMIT");
    valid = true;
    expect(await memory.prepare()).toContain("Bevar beslutningen.");
    expect(await memory.zoom(0, 1)).toContain("Kildetekst ".repeat(100));
  } finally {
    await memory.close();
    await harness.close(context);
  }
});

test("startup rebuild failure stays isolated, chat works and same generation resumes", async () => {
  const models = createModels();
  const faux = fauxProvider();
  models.setProvider(faux.provider);
  let prompt = "";
  faux.setResponses([
    (request) => {
      prompt = JSON.stringify(request.messages);
      return fauxAssistantMessage([fauxText("Chat still works.")]);
    },
  ]);
  let valid = false;
  let failed!: () => void;
  const failure = new Promise<void>((resolve) => {
    failed = resolve;
  });
  const memory = createMemory(
    {
      rebuildRequested: true,
      compress: async () => (valid ? "user: Bevar originalsproget." : "ø".repeat(257)),
      onError: () => {
        if (memory.status().rebuild?.error) failed();
      },
    },
    models,
  );
  const registry = createRegistry();
  registry.install(memory.extension);
  const storage = new MemoryStorage();
  const harness = await Harness.open(storage, { models, registry }, context);
  const main = await harness.root(context, {
    agent: { model: { provider: "faux", modelId: "faux-1" } },
  });
  try {
    const source = "Bevar originalsproget. ".repeat(50);
    await main.commit(
      (tx) =>
        tx.appendEntry(main.id, {
          kind: "pi.user",
          model: [{ role: "user", content: source, timestamp: 1 }],
        }),
      context,
    );
    await memory.bind(harness, main, storage);
    await failure;
    const generation = memory.status().rebuild!.generation;
    expect(memory.status().rebuild!.error).toContain("exceeds 512");
    const result = await (
      await main.submit({ type: "input", content: "Continue chatting" }, context)
    ).wait(context);
    expect(result.status).toBe("done");
    expect(prompt).toContain("0+1|(not summarized yet: zoom it)");
    expect(await memory.contextFor(main.id, "chat-only")).toBeDefined();
    expect(await memory.zoom(0, 1)).toContain(source);
    expect(await harness.snapshot(MemoryNodesDoc, main.id, "0+1", context)).toBeUndefined();
    valid = true;
    await memory.rebuild();
    expect(memory.status().rebuild!.generation).toBe(generation);
    expect(memory.status().rebuild!.error).toBeUndefined();
    expect(await memory.zoom(0, 1)).toContain(source);
  } finally {
    await memory.close();
    await harness.close(context);
  }
});
