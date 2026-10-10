import { expect, test } from "vite-plus/test";
import { fauxAssistantMessage, fauxToolCall, fauxText } from "@earendil-works/pi-ai/providers/faux";
import type { Message, ToolResultMessage } from "@earendil-works/pi-ai";
import { isMainMemoryView, withoutMainMemory } from "./main-memory-policy";

test.each([
  ["memory_zoom", "memory_date"],
  ["zoom", "date"],
])("cross-workspace copies exclude current and archived %s/%s results", (zoomName, dateName) => {
  const zoom = fauxToolCall(zoomName, { id: 1, n: 1 });
  const code = fauxToolCall("codemode", {
    code: "text(await tools.memory_date({id: 1})); text(await tools.memory_zoom({id: 1, n: 1}));",
  });
  const read = fauxToolCall("read", { path: "task.txt" });
  const result = (call: typeof zoom, text: string): ToolResultMessage => ({
    role: "toolResult",
    toolCallId: call.id,
    toolName: call.name,
    content: [{ type: "text", text }],
    isError: false,
    timestamp: 1,
  });
  const messages: Message[] = [
    { role: "user", content: "<chat>\n1+1|private main decision\n</chat>", timestamp: 0 },
    { role: "user", content: "ordinary assigned task", timestamp: 1 },
    fauxAssistantMessage([zoom, read, fauxText("Task progress")]),
    result(zoom, "private full memory"),
    result(read, "ordinary file contents"),
    fauxAssistantMessage([code]),
    {
      ...result(code, "private codemode memory"),
      details: { calls: [{ name: dateName }, { name: zoomName }] },
    },
  ];
  const isolated = withoutMainMemory(messages);
  expect(JSON.stringify(isolated)).not.toContain("private");
  expect(isolated).toEqual([
    messages[1],
    { ...messages[2], content: [read, fauxText("Task progress")] },
    messages[4],
  ]);
  expect(isolated.some(isMainMemoryView)).toBe(false);
});

test("ordinary chat markup and JavaScript helper names are not main-memory content", () => {
  const messages: Message[] = [
    { role: "user", content: "Review the <chat> renderer", timestamp: 0 },
    fauxAssistantMessage([
      fauxToolCall("codemode", { code: "function zoom() { return 'task'; } text(zoom());" }),
    ]),
    {
      role: "toolResult",
      toolName: "codemode",
      toolCallId: "call",
      content: [{ type: "text", text: "task" }],
      isError: false,
      timestamp: 1,
    },
  ];
  expect(messages.some(isMainMemoryView)).toBe(false);
  expect(withoutMainMemory(messages)).toEqual(messages);
});
