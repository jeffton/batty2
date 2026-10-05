import { expect, test, vi } from "vite-plus/test";
import { mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { useAppStore } from "@/client/stores/app";
import ChatSessionPane from "./ChatSessionPane.vue";
import type { SessionState } from "@/shared/types";

vi.mock("@/client/lib/api", () => ({
  listRunningSubagents: vi.fn().mockResolvedValue([]),
  getMain: vi.fn(),
}));

test("initial main snapshot shows preparation and SSE memory errors without polling", async () => {
  setActivePinia(createPinia());
  const store = useAppStore();
  store.activeSession = {
    sessionId: "main",
    messages: [],
    thinkingLevel: "medium",
    availableThinkingLevels: ["medium"],
    isStreaming: false,
    isCompacting: false,
    memoryPreparation: { pending: 8, totalLeaves: 10, builtLeaves: 2 },
  } as unknown as SessionState;
  const wrapper = mount(ChatSessionPane, {
    global: {
      stubs: {
        ChatHeader: true,
        SessionTranscriptView: true,
        ModelConfigSelector: true,
        ComposerQueuedPrompts: true,
      },
    },
  });
  try {
    expect(wrapper.text()).toContain("Preparing memory");
    expect(wrapper.text()).not.toContain("Compacting");
    store.activeSession.memoryPreparation = {
      pending: 0,
      totalLeaves: 10,
      builtLeaves: 10,
      error: "Memory failed",
    };
    await wrapper.vm.$nextTick();
    expect(wrapper.text()).toContain("Memory failed");
    expect(wrapper.text()).not.toContain("Preparing memory");
    expect(wrapper.text()).not.toContain("Compacting");
  } finally {
    wrapper.unmount();
  }
});
