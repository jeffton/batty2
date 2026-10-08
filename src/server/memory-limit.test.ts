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
    expect(corrections[4]).toContain("514 UTF-8 bytes");
    expect(corrections[4]).toContain("Rewrite it more concisely");
    expect(corrections[4]).not.toContain("← LIMIT");
    valid = true;
    expect(await memory.prepare()).toContain("Bevar beslutningen.");
    expect(await memory.zoom(0, 1)).toContain("Kildetekst ".repeat(100));
  } finally {
    await memory.close();
    await harness.close(context);
  }
});
