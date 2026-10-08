import { expect, test } from "vite-plus/test";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxText } from "@earendil-works/pi-ai/providers/faux";
import { createRegistry, Harness, MemoryStorage } from "@earendil-works/pi-durable";
import { createMemory, MemoryNodesDoc } from "./memory";

test.each([false, true])(
  "five oversize responses keep the shortest candidate across transport retries (%s)",
  async (transientError) => {
    const models = createModels();
    models.setProvider(fauxProvider().provider);
    const candidates = [
      "ø".repeat(300),
      "ø".repeat(257),
      "x".repeat(520),
      "ø".repeat(280),
      "x".repeat(530),
    ];
    const corrections: string[] = [];
    let completed = 0;
    models.completeSimple = async (_, request) => {
      corrections.push(JSON.stringify(request.messages));
      if (transientError && corrections.length === 3)
        throw new Error("Temporary transport failure");
      return fauxAssistantMessage([fauxText(candidates[completed++]!)]);
    };
    const memory = createMemory(
      { memoryModel: "faux/faux-1", retryMs: 1, onError: () => {} },
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
      await memory.bind(harness, main, storage);
      const source = "Kildetekst ".repeat(100);
      await main.commit(
        (tx) =>
          tx.appendEntry(main.id, {
            kind: "pi.user",
            model: [{ role: "user", content: source, timestamp: 1 }],
          }),
        context,
      );
      expect(await memory.prepare()).toContain(candidates[1]);
      expect(completed).toBe(5);
      expect(corrections).toHaveLength(transientError ? 6 : 5);
      expect((await harness.snapshot(MemoryNodesDoc, main.id, "0+1", context))?.text).toBe(
        candidates[1],
      );
      expect(corrections[0]).toContain("-".repeat(512));
      expect(corrections.at(-1)).toContain("162 UTF-8 bytes");
      expect(corrections.at(-1)).toContain("retaining its languages");
      expect(corrections.at(-1)).not.toContain(candidates[0]);
      await memory.prepare();
      expect(completed).toBe(5);
      expect(corrections).toHaveLength(transientError ? 6 : 5);
      expect(await memory.zoom(0, 1)).toContain(source);
    } finally {
      await memory.close();
      await harness.close(context);
    }
  },
);

test("startup model failure remains isolated and the same generation resumes after recovery", async () => {
  const models = createModels();
  let failed!: () => void;
  const failure = new Promise<void>((resolve) => {
    failed = resolve;
  });
  const memory = createMemory(
    {
      memoryModel: "faux/faux-1",
      rebuildRequested: true,
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
    expect(memory.status().rebuild!.error).toContain("Memory model unavailable");
    const faux = fauxProvider();
    models.setProvider(faux.provider);
    models.completeSimple = async () =>
      fauxAssistantMessage([fauxText("user: Bevar originalsproget.")]);
    faux.setResponses([fauxAssistantMessage([fauxText("Chat still works.")])]);
    const result = await (
      await main.submit({ type: "input", content: "Continue chatting" }, context)
    ).wait(context);
    expect(result.status).toBe("done");
    await memory.rebuild();
    expect(memory.status().rebuild!.generation).toBe(generation);
    expect(memory.status().rebuild!.error).toBeUndefined();
    expect(await memory.zoom(0, 1)).toContain(source);
  } finally {
    await memory.close();
    await harness.close(context);
  }
});
