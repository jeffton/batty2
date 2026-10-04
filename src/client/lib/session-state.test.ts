import { describe, expect, it } from "vite-plus/test";
import { applyServerEvent } from "./session-events";
import type { SessionState, UiMessage } from "@/shared/types";

function message(id: string, text = id): UiMessage {
  return { id, role: "user", timestamp: 1, blocks: [{ type: "text", text }] };
}
function state(messages: UiMessage[], revision: number): SessionState {
  return {
    id: "main",
    sessionId: "main",
    workspaceId: "main",
    cwd: "/",
    thinkingLevel: "medium",
    availableThinkingLevels: ["medium"],
    isStreaming: false,
    pendingMessageCount: 0,
    updatedAt: 1,
    contextTokens: null,
    contextWindow: null,
    contextPercent: null,
    totalMessageCount: 4,
    hasMoreMessages: true,
    messagesDetailLevel: "full",
    messages,
    activeTools: [],
    revision,
    streamId: "durable-main",
  };
}
describe("main transcript resets", () => {
  it("retains paginated history and replaces overlapping durable entries with current data", () => {
    const previous = state(
      [message("entry-alpha"), message("entry-beta"), message("entry-gamma")],
      4,
    );
    const incoming = state(
      [message("entry-beta", "Updated"), message("entry-gamma"), message("entry-delta")],
      5,
    );
    const merged = applyServerEvent(previous, {
      type: "reset",
      state: incoming,
      revision: 5,
      streamId: "durable-main",
    })!;
    expect(merged.messages.map((item) => item.id)).toEqual([
      "entry-alpha",
      "entry-beta",
      "entry-gamma",
      "entry-delta",
    ]);
    expect(merged.messages[1]).toEqual(message("entry-beta", "Updated"));
  });
  it("keeps pagination exhausted across windowed resets that contain fewer messages", () => {
    const previous = {
      ...state([message("a"), message("b"), message("c"), message("d")], 4),
      hasMoreMessages: false,
    };
    const incoming = state([message("c"), message("d")], 5);
    const merged = applyServerEvent(previous, {
      type: "reset",
      state: incoming,
      revision: 5,
      streamId: "durable-main",
    })!;
    expect(merged.messages.map((item) => item.id)).toEqual(["a", "b", "c", "d"]);
    expect(merged.hasMoreMessages).toBe(false);
    const grown = applyServerEvent(merged, {
      type: "reset",
      state: { ...state([message("d"), message("e")], 6), totalMessageCount: 5 },
      revision: 6,
      streamId: "durable-main",
    })!;
    expect(grown.messages).toHaveLength(5);
    expect(grown.hasMoreMessages).toBe(false);
  });
  it("keeps pagination available when retained history has gaps", () => {
    const previous = {
      ...state([message("a"), message("b")], 4),
      hasMoreMessages: false,
      totalMessageCount: 2,
    };
    const incoming = state([message("c"), message("d")], 5);
    const merged = applyServerEvent(previous, {
      type: "reset",
      state: incoming,
      revision: 5,
      streamId: "durable-main",
    })!;
    expect(merged.messages.map((item) => item.id)).toEqual(["c", "d"]);
    expect(merged.hasMoreMessages).toBe(true);
  });
  it("does not roll the transcript back when a stale snapshot arrives", () => {
    const current = state([message("entry-latest")], 8);
    expect(
      applyServerEvent(current, {
        type: "reset",
        state: state([message("entry-old")], 7),
        revision: 7,
        streamId: "durable-main",
      }),
    ).toBe(current);
  });
});
