import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vite-plus/test";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { createRegistry, Harness, MemoryStorage } from "@earendil-works/pi-durable";
import { importRoyPlan, planRoyImport } from "../../scripts/import-roy.js";

test("daily import excludes workers, orders and deduplicates original records, preserves attachments and resumes", async () => {
  const root = await mkdtemp(join(tmpdir(), "batty-roy-import-"));
  const source = join(root, "source");
  const target = join(root, "target");
  const sessions = join(source, "sessions", "roy");
  await mkdir(sessions, { recursive: true });
  const header = (id: string) => ({ type: "session", id, timestamp: "2026-01-01T00:00:00Z" });
  const marker = {
    type: "custom",
    id: "marker",
    customType: "batty-cron-session",
    data: { kind: "daily" },
    timestamp: "2026-01-01T00:00:01Z",
  };
  const user = {
    type: "message",
    id: "z-user",
    timestamp: "2026-01-01T00:00:02Z",
    message: {
      role: "user",
      content: [
        { type: "text", text: "Keep original /api/uploads/original-session/batch/image.png" },
        { type: "image", mimeType: "image/png", data: "base64exact" },
      ],
      timestamp: 1000,
      clientMessageId: "client-original",
    },
  };
  const tool = {
    type: "message",
    id: "a-tool",
    timestamp: "2026-01-01T00:00:02Z",
    message: {
      role: "toolResult",
      toolCallId: "call",
      toolName: "read",
      content: [{ type: "text", text: "exact output" }],
      details: { full: true },
      isError: false,
      timestamp: 2000,
    },
  };
  const jsonl = (entries: unknown[]) =>
    entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n";
  await writeFile(join(sessions, "first.jsonl"), jsonl([header("daily1"), marker, user, tool]));
  await writeFile(join(sessions, "fork.jsonl"), jsonl([header("daily2"), marker, user, tool]));
  await writeFile(
    join(sessions, "worker.jsonl"),
    jsonl([
      header("worker"),
      marker,
      { type: "custom", customType: "batty-subagent-session" },
      { ...user, id: "worker-user" },
    ]),
  );
  await mkdir(join(source, "uploads", "original-session", "batch"), { recursive: true });
  await writeFile(
    join(source, "uploads", "original-session", "batch", "image.png"),
    "original image bytes",
  );
  await mkdir(join(source, "uploads", "unrelated"), { recursive: true });
  await writeFile(join(source, "uploads", "unrelated", "private"), "not referenced");
  const harness = await Harness.open(
    new MemoryStorage(),
    { models: createModels(), registry: createRegistry() },
    context,
  );
  try {
    const main = await harness.root(context);
    const plan = await planRoyImport(source);
    expect(plan.sessions).toHaveLength(2);
    expect(plan.records).toHaveLength(5);
    expect(plan.records.findIndex((record) => record.sourceId === "z-user")).toBeLessThan(
      plan.records.findIndex((record) => record.sourceId === "a-tool"),
    );
    const first = await importRoyPlan(plan, main, source, target, () => undefined);
    expect(first.imported).toBe(5);
    expect((await main.context(context)).messages).toEqual([]);
    await main.commit(
      (tx) =>
        tx.appendEntry(main.id, {
          kind: "test.input",
          model: [{ role: "user", content: "live work", timestamp: 1 }],
        }),
      context,
    );
    const second = await importRoyPlan(plan, main, source, target, () => undefined);
    expect(second).toMatchObject({ imported: 0, skipped: 5 });
    expect((await main.context(context)).messages).toEqual([
      { role: "user", content: "live work", timestamp: 1 },
    ]);
    await writeFile(
      join(sessions, "first.jsonl"),
      jsonl([
        header("daily1"),
        marker,
        user,
        tool,
        { ...user, id: "expanded", timestamp: "2026-01-01T00:00:04Z" },
      ]),
    );
    await expect(
      importRoyPlan(await planRoyImport(source), main, source, target, () => undefined),
    ).rejects.toThrow("before live main-thread work");
    expect((await main.context(context)).messages).toEqual([
      { role: "user", content: "live work", timestamp: 1 },
    ]);
    const page = await main.entries({}, 100, undefined, context);
    expect(page.items.filter((entry) => entry.kind === "batty.archive-head")).toHaveLength(1);
    const importedUser = page.items.find((entry) => entry.kind === "pi.user")!;
    expect(importedUser.model![0]).toEqual(user.message);
    expect(importedUser.data).toMatchObject({ original: user });
    expect(page.items.find((entry) => entry.kind === "pi.tool-result")!.model![0]).toEqual(
      tool.message,
    );
    expect(JSON.stringify(page.items)).not.toContain("worker-user");
    expect(
      await readFile(join(target, "uploads", "original-session", "batch", "image.png"), "utf8"),
    ).toBe("original image bytes");
    await expect(readFile(join(target, "uploads", "unrelated", "private"))).rejects.toThrow();
  } finally {
    await harness.close(context);
    await rm(root, { recursive: true, force: true });
  }
});
