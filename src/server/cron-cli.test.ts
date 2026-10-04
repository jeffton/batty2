import { expect, test } from "vite-plus/test";
import { parseCronArgs } from "./cron-cli";

test("wake workout preserves prompt, model, workspace and detached context", async () => {
  const { body } = await parseCronArgs([
    "cron",
    "add",
    "--workspace",
    "roy",
    "--prompt",
    "David's activity\npt.md",
    "--model",
    "openai-codex/gpt-6.1-sol",
    "--thinking",
    "medium",
    "--in",
    "3m",
    "--session",
    "daily-detached",
    "--daily-context",
    "chat-only",
  ]);
  expect(body).toEqual({
    action: "add",
    workspaceId: "roy",
    prompt: "David's activity\npt.md",
    model: "openai-codex/gpt-6.1-sol",
    thinkingLevel: "medium",
    schedule: { kind: "at", in: "3m" },
    session: { kind: "daily-detached", includePreviousContext: "chat-only" },
  });
});

test("disabled updates and log requests are typed", async () => {
  expect((await parseCronArgs(["cron", "update", "id", "--enabled", "false"])).body).toEqual({
    action: "update",
    jobId: "id",
    enabled: false,
  });
  expect((await parseCronArgs(["cron", "list-run-logs", "--limit", "10"])).body.limit).toBe(10);
});

test("ambiguous schedules and malformed flags fail before contacting service", async () => {
  await expect(parseCronArgs(["cron", "add", "--in", "3m", "--every", "5m"])).rejects.toThrow(
    "one schedule",
  );
  await expect(parseCronArgs(["cron", "add", "--enabled", "no"])).rejects.toThrow("true or false");
  await expect(parseCronArgs(["cron", "add", "--daily-context", "false"])).rejects.toThrow(
    "requires --session",
  );
  await expect(parseCronArgs(["cron", "list", "--unknown"])).rejects.toThrow();
});
