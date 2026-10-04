import { expect, test } from "vite-plus/test";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { Harness, createRegistry, MemoryStorage } from "@earendil-works/pi-durable";
import { historyPage } from "./runtime";
import { retainInput } from "./input-receipts";

test("archive pagination crosses invisible entries and retains history outside the active head", async () => {
  const storage = new MemoryStorage();
  const harness = await Harness.open(
    storage,
    { models: createModels(), registry: createRegistry() },
    context,
  );
  try {
    const main = await harness.root(context);
    await main.commit(async (tx) => {
      await tx.appendEntry(main.id, {
        kind: "pi.user",
        model: [{ role: "user", content: "old original", timestamp: 1 }],
      });
      for (let index = 0; index < 150; index++)
        await tx.appendEntry(main.id, { kind: "bookkeeping", data: { index } });
      await tx.appendEntry(main.id, { kind: "archive-head", head: "self" });
      await tx.appendEntry(main.id, {
        kind: "pi.user",
        model: [{ role: "user", content: "recent", timestamp: 2 }],
      });
    }, context);
    const recent = await historyPage(storage, main.id, undefined, 1);
    expect(recent.messages[0]).toMatchObject({
      role: "user",
      blocks: [{ type: "text", text: "recent" }],
    });
    const older = await historyPage(storage, main.id, recent.messages[0]!.id, 1);
    expect(older.messages[0]).toMatchObject({
      role: "user",
      blocks: [{ type: "text", text: "old original" }],
    });
    expect(
      (await main.context(context)).messages.some(
        (message) => message.role === "user" && message.content === "old original",
      ),
    ).toBe(false);
    expect((await historyPage(storage, main.id, older.messages[0]!.id, 1)).hasMoreMessages).toBe(
      false,
    );
  } finally {
    await harness.close(context);
  }
});

test("withdrawn queued input has one immutable receipt after an idempotent retry", async () => {
  const storage = new MemoryStorage();
  const harness = await Harness.open(
    storage,
    { models: createModels(), registry: createRegistry() },
    context,
  );
  try {
    const main = await harness.root(context);
    const submissionId = await main.commit(
      async (tx) =>
        (
          await tx.createSubmission({
            conversationId: main.id,
            type: "input",
            status: "queued",
            requestId: "retry-id",
          })
        ).id,
      context,
    );
    await retainInput(main, submissionId, "never lose these words", "retry-id");
    await retainInput(main, submissionId, "never lose these words", "retry-id");
    await main.commit(
      (tx) => tx.settleSubmission(submissionId, { status: "unanswered", reason: "aborted" }),
      context,
    );
    const entries = await storage.scanEntries({ conversationId: main.id }, 20, undefined, context);
    const receipts = entries.items.filter((entry) => entry.kind === "batty.input-admitted");
    expect(receipts).toHaveLength(1);
    expect(receipts[0]!.data).toMatchObject({
      content: "never lose these words",
      clientMessageId: "retry-id",
    });
  } finally {
    await harness.close(context);
  }
});
