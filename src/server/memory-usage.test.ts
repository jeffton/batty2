import { expect, test } from "vite-plus/test";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxText } from "@earendil-works/pi-ai/providers/faux";
import { createRegistry, Harness, MemoryStorage } from "@earendil-works/pi-durable";
import { createMemory } from "./memory";

const usage = {
  input: 10,
  cacheRead: 20,
  cacheWrite: 2,
  output: 5,
  reasoning: 3,
  totalTokens: 37,
  cost: { input: 0.1, cacheRead: 0.02, cacheWrite: 0.01, output: 0.2, total: 0.33 },
};

test("memory ledger measures rejected, correction and rebuild attempts without storing user contents", async () => {
  const models = createModels();
  models.setProvider(fauxProvider().provider);
  let calls = 0;
  models.completeSimple = async () => {
    calls++;
    if (calls === 1) throw new Error("transport failed with private source");
    const response = fauxAssistantMessage([fauxText(calls === 3 ? "x".repeat(100) : "short")]);
    response.usage = { ...usage };
    if (calls === 2) {
      response.stopReason = "error";
      response.errorMessage = "503 overload";
    }
    return response;
  };
  const memory = createMemory(
    { memoryModel: "faux/faux-1", nodeBytes: 80, retryMs: 1, onError: () => {} },
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
    expect((await memory.usage()).since).toBeNull();
    await main.commit(
      (tx) =>
        tx.appendEntry(main.id, {
          kind: "pi.user",
          model: [{ role: "user", content: "private source ".repeat(20), timestamp: 1 }],
        }),
      context,
    );
    await memory.prepare();
    const measured = await memory.usage();
    expect(measured.incremental).toEqual({
      attempts: 4,
      measured: 3,
      unmeasured: 1,
      input: 30,
      cacheRead: 60,
      cacheWrite: 6,
      output: 15,
      reasoning: 9,
      totalTokens: 111,
      apiEquivalentCost: 0.99,
    });
    expect(measured.costBasis).toContain("not subscription");
    expect(measured.coverage).toContain("unknown");
    await memory.rebuild();
    expect((await memory.usage()).rebuild).toMatchObject({ attempts: 1, measured: 1, input: 10 });
    const ledger = (await main.entries({}, 100, undefined, context)).items.filter(
      (entry) => entry.kind === "batty.memory-call",
    );
    expect(ledger).toHaveLength(5);
    expect(JSON.stringify(ledger)).not.toContain("private source");
    expect(ledger.every((entry) => !entry.model)).toBe(true);
    expect(ledger.map((entry) => entry.data)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ operation: "rebuild", generation: 1, attempt: 1 }),
        expect.objectContaining({ operation: "incremental", attempt: 4 }),
        expect.objectContaining({ stopReason: "thrown", usage: null }),
      ]),
    );
    const callsBefore = calls;
    await memory.prepare();
    expect(calls).toBe(callsBefore);
    expect((await memory.usage()).incremental).toEqual(measured.incremental);
    expect(await memory.zoom(0, 1)).toContain("private source");
    expect(memory.status().totalLeaves).toBe(1);
  } finally {
    await memory.close();
    await harness.close(context);
  }
});
