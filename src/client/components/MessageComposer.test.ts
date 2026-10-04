import { describe, expect, it } from "vite-plus/test";
import { mount } from "@vue/test-utils";
import MessageComposer from "./MessageComposer.vue";

describe("memory preparation", () => {
  it("shows preparation progress without blocking main prompts", async () => {
    const wrapper = mount(MessageComposer, {
      props: {
        compacting: true,
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
      expect(wrapper.text()).toContain("Preparing memory");
      await wrapper.get("textarea").setValue("Queue this while memory is prepared");
      const send = wrapper.get('button[aria-label="Send prompt"]');
      expect(send.attributes("disabled")).toBeUndefined();
      await send.trigger("click");
      expect(wrapper.emitted("submit")?.[0]).toEqual(["Queue this while memory is prepared", []]);
    } finally {
      wrapper.unmount();
    }
  });
});
