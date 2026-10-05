import { mount } from "@vue/test-utils";
import { expect, test } from "vite-plus/test";
import TranscriptDetailsButton from "./TranscriptDetailsButton.vue";

test("details control points toward the action in both states", async () => {
  const wrapper = mount(TranscriptDetailsButton, { props: { expanded: false } });
  const button = wrapper.get("button");

  expect(button.attributes("aria-expanded")).toBe("false");
  expect(button.attributes("aria-label")).toBe("Show details");
  expect(button.attributes("title")).toBe("Show details");
  expect(button.classes()).toContain("details-button");
  expect(wrapper.get("svg").classes()).toContain("lucide-chevron-up");

  await wrapper.setProps({ expanded: true });
  expect(button.attributes("aria-expanded")).toBe("true");
  expect(button.attributes("aria-label")).toBe("Collapse details");
  expect(button.attributes("title")).toBe("Collapse details");
  expect(wrapper.get("svg").classes()).toContain("lucide-chevron-down");

  await button.trigger("click");
  expect(wrapper.emitted("toggle")).toHaveLength(1);
});
