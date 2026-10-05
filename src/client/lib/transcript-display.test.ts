import { expect, test } from "vite-plus/test";
import { buildTranscriptDisplayEntries } from "./transcript-display";
import type { TranscriptMessageView } from "./transcript";
import type { UiMessage } from "@/shared/types";

const tools = new Map();
const user: UiMessage = {
  id: "u",
  role: "user",
  timestamp: 1,
  blocks: [{ type: "text", text: "Question" }],
};
function reply(
  id: string,
  extra: Partial<Extract<UiMessage, { role: "assistant" }>> = {},
): UiMessage {
  return {
    id,
    role: "assistant",
    timestamp: 2,
    turnPhase: "final",
    blocks: [
      { type: "thinking", thinking: "Reasoning" },
      { type: "text", text: "Answer" },
    ],
    ...extra,
  };
}
function views(messages: UiMessage[]): TranscriptMessageView[] {
  return messages.map((message) => ({ message, toolStatesByCallId: tools }));
}
function display(messages: UiMessage[], options = {}) {
  return buildTranscriptDisplayEntries(views(messages), tools, options).entries;
}

test("finished and persisted sections collapse, with one section control on the last reply", () => {
  const messages = [user, reply("a"), reply("b")];
  const collapsed = display(messages);
  expect(collapsed.map((entry) => entry.kind === "message" && entry.detailsToggle)).toEqual([
    undefined,
    undefined,
    { sectionKey: "turn:u", expanded: false },
  ]);
  expect(JSON.stringify(collapsed)).not.toContain("Reasoning");
  const expanded = display(messages, { openDetailsSectionKey: "turn:u" });
  expect(JSON.stringify(expanded)).toContain("Reasoning");
  expect(expanded.at(-1)).toMatchObject({ detailsToggle: { expanded: true } });
});

test("streaming expands only the active section, and finishing collapses it", () => {
  const messages = [
    user,
    reply("old"),
    { ...user, id: "next" },
    reply("live", { turnPhase: "intermediate" }),
  ];
  const running = display(messages, { isStreaming: true });
  expect(running[1]).toMatchObject({ detailsToggle: { expanded: false } });
  expect(running.at(-1)).not.toHaveProperty("detailsToggle");
  expect(JSON.stringify(running.at(-1))).toContain("Reasoning");
  messages[3] = reply("live");
  expect(display(messages).at(-1)).toMatchObject({
    detailsToggle: { sectionKey: "turn:next", expanded: false },
  });
});

test("cron/runtime sections run automatically and reply-less notices or aborts remain accessible", () => {
  const notice: UiMessage = {
    id: "cron",
    role: "custom",
    timestamp: 3,
    customType: "cron",
    text: "Cron notice",
    data: { cron: {} },
  };
  const messages = [user, reply("old"), notice, reply("cron-reply")];
  const running = display(messages, { isStreaming: true });
  expect(
    running.some((entry) => entry.kind === "message" && entry.entry.message.id === "cron"),
  ).toBe(true);
  const finished = display(messages);
  expect(finished.at(-1)).toMatchObject({ detailsToggle: { sectionKey: "turn:cron" } });
  expect(display([notice])).toHaveLength(1);
  const aborted = reply("aborted", {
    turnPhase: "intermediate",
    stopReason: "aborted",
    blocks: [{ type: "thinking", thinking: "Interrupted work" }],
  });
  expect(JSON.stringify(display([user, aborted]))).toContain("Interrupted work");
});

test("silent cron turns retain details, and a sentinel after a real reply keeps its control", () => {
  const notice: UiMessage = {
    id: "cron",
    role: "custom",
    timestamp: 3,
    customType: "cron",
    text: "Cron notice",
  };
  const silent = reply("silent", {
    blocks: [
      { type: "thinking", thinking: "Silent work" },
      { type: "text", text: "NO_REPLY" },
    ],
  });
  expect(JSON.stringify(display([notice, silent]))).toContain("Silent work");
  const result = display([notice, reply("real"), silent]);
  expect(result).toHaveLength(1);
  expect(result[0]).toMatchObject({
    entry: { message: { id: "real" } },
    detailsToggle: { sectionKey: "turn:cron" },
  });
});

test("errors remain visible and details preference has no duplicate controls", () => {
  const failed = reply("error", {
    blocks: [{ type: "thinking", thinking: "Reasoning" }],
    stopReason: "error",
    errorMessage: "Useful failure",
  });
  const result = display([user, failed]);
  expect(JSON.stringify(result)).toContain("Useful failure");
  expect(result.at(-1)).toHaveProperty("detailsToggle");
  const always = display([user, failed], { alwaysShowDetails: true });
  expect(JSON.stringify(always)).toContain("Reasoning");
  expect(always.every((entry) => entry.kind === "message" && !entry.detailsToggle)).toBe(true);
});
