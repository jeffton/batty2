import { describe, expect, it } from "vite-plus/test";
import { mount } from "@vue/test-utils";
import MessageComposer from "./MessageComposer.vue";

describe("memory preparation", () => {
  it("shows preparation progress without blocking main prompts", async () => {
    const wrapper = mount(MessageComposer, {
      props: {
        compacting: false,
        memoryPending: 8,
        sessionKey: "main",
        modelPopoverId: "model-test",
        modelPopoverAnchor: "--model-test",
        models: [],
        currentThinkingLevel: "medium",
        thinkingOptions: ["medium"],
        modelButtonLabel: "Model",
        thinkingButtonLabel: "Medium",
      },
      global: { stubs: { ModelConfigSelector: true, ComposerQueuedPrompts: true } },
    });
    try {
      // The initial session snapshot supplies this before any memory-status request.
      expect(wrapper.text()).toContain("Preparing memory");
      expect(wrapper.text()).not.toContain("Compacting");
      await wrapper.get("textarea").setValue("Queue this while memory is prepared");
      const send = wrapper.get('button[aria-label="Send prompt"]');
      expect(send.attributes("disabled")).toBeUndefined();
      await send.trigger("click");
      expect(wrapper.emitted("submit")?.[0]).toEqual(["Queue this while memory is prepared", []]);

      await wrapper.setProps({ memoryPending: 0, error: "Memory summarizer failed" });
      expect(wrapper.text()).toContain("Memory summarizer failed");
      expect(wrapper.text()).not.toContain("Preparing memory");
      expect(wrapper.text()).not.toContain("Compacting");

      await wrapper.setProps({ compacting: true, error: undefined });
      expect(wrapper.text()).toContain("Compacting");
      expect(wrapper.text()).not.toContain("Preparing memory");
    } finally {
      wrapper.unmount();
    }
  });
});
