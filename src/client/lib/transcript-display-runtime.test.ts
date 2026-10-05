import { expect, test } from "vite-plus/test";
import { buildTranscriptDisplayEntries } from "./transcript-display";
import { buildToolStateLookup, buildTranscriptMessages } from "./transcript";
import type { UiMessage } from "@/shared/types";

// The main transcript around subagent 146858: another worker's result arrived
// after launch but before the final reply, followed later by the spacing result.
export const runtimeMessages: UiMessage[] = [
  { id: "146845", role: "user", timestamp: 1, blocks: [{ type: "text", text: "Fix spacing" }] },
  {
    id: "146855",
    role: "assistant",
    timestamp: 2,
    turnPhase: "intermediate",
    blocks: [
      {
        type: "toolCall",
        id: "launch",
        name: "subagent",
        arguments: { action: "run", prompt: "Header spacing task" },
      },
    ],
  },
  {
    id: "146866",
    role: "toolResult",
    timestamp: 3,
    toolCallId: "launch",
    toolName: "subagent",
    isError: false,
    blocks: [{ type: "text", text: "Started. Session ID: 146858" }],
  },
  {
    id: "146870",
    role: "custom",
    timestamp: 4,
    customType: "batty-runtime-notice:subagent",
    text: "[subagent 146278 result] Codemode deployed",
  },
  {
    id: "146874",
    role: "assistant",
    timestamp: 5,
    turnPhase: "final",
    blocks: [{ type: "text", text: "Codemode-fixet er live. Logoets spacing-fix kører stadig" }],
  },
  {
    id: "147048",
    role: "custom",
    timestamp: 6,
    customType: "batty-runtime-notice:subagent",
    text: "[subagent 146858 result] Spacing deployed",
  },
  {
    id: "147053",
    role: "assistant",
    timestamp: 7,
    turnPhase: "final",
    blocks: [{ type: "text", text: "Spacing er rettet og live" }],
  },
];

function display(messages: UiMessage[], options = {}) {
  const lookup = buildToolStateLookup(messages, []);
  return buildTranscriptDisplayEntries(
    buildTranscriptMessages(messages, lookup, false),
    lookup.toolStatesByCallId,
    options,
  ).entries;
}

test("an async notice during tool work does not strand the launch in an expanded reply-less section", () => {
  const running = display(runtimeMessages.slice(0, 4), { isStreaming: true });
  expect(JSON.stringify(running)).toContain("Header spacing task");
  expect(running.every((entry) => entry.kind === "message" && !entry.detailsToggle)).toBe(true);

  const firstReply = display(runtimeMessages.slice(0, 5));
  expect(JSON.stringify(firstReply)).not.toContain("Header spacing task");
  expect(firstReply.at(-1)).toMatchObject({
    detailsToggle: { sectionKey: "turn:146845", expanded: false },
  });

  const delivered = display(runtimeMessages, { isStreaming: true });
  expect(JSON.stringify(delivered)).not.toContain("Header spacing task");
  expect(JSON.stringify(delivered)).toContain("Spacing deployed");
  const finished = display(runtimeMessages);
  expect(JSON.stringify(finished)).not.toContain("Header spacing task");
  expect(JSON.stringify(finished)).not.toContain("Spacing deployed");
  expect(finished.filter((entry) => entry.kind === "message" && entry.detailsToggle)).toHaveLength(
    2,
  );
});

test("manual expansion and always-show preference retain the completed launch details", () => {
  const manual = display(runtimeMessages, { openDetailsSectionKey: "turn:146845" });
  expect(JSON.stringify(manual)).toContain("Header spacing task");
  expect(manual.at(-1)).toMatchObject({ detailsToggle: { expanded: false } });
  const always = display(runtimeMessages, { alwaysShowDetails: true });
  expect(JSON.stringify(always)).toContain("Header spacing task");
  expect(always.every((entry) => entry.kind === "message" && !entry.detailsToggle)).toBe(true);
});

test("consecutive runtime notices during unfinished work share its final reply control", () => {
  const messages = [
    runtimeMessages[3]!,
    runtimeMessages[1]!,
    { ...runtimeMessages[3]!, id: "steer", text: "Steering update" },
    runtimeMessages[4]!,
  ];
  expect(JSON.stringify(display(messages))).not.toContain("Header spacing task");
  expect(display(messages).at(-1)).toMatchObject({
    detailsToggle: { sectionKey: "turn:146870", expanded: false },
  });
});
