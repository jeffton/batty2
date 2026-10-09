import { mount } from "@vue/test-utils";
import { expect, test, vi } from "vite-plus/test";
import AgentTurnDiffPopover from "./AgentTurnDiffPopover.vue";

const { setItems } = vi.hoisted(() => ({ setItems: vi.fn() }));
vi.mock("@pierre/diffs", () => ({
  parsePatchFiles: (patch: string) => [{ files: [{ patch }] }],
  CodeView: class {
    setup() {}
    cleanUp() {}
    setItems = setItems;
  },
}));

test("same-path immutable diffs have distinct viewer items", async () => {
  const files = [
    { path: "a.ts", patch: "first patch" },
    { path: "a.ts", patch: "second patch" },
  ];
  const wrapper = mount(AgentTurnDiffPopover, {
    props: { popoverId: "diffs", files },
    global: { stubs: { FullPopover: { name: "FullPopover", template: "<div><slot /></div>" } } },
  });
  wrapper.findComponent({ name: "FullPopover" }).vm.$emit("toggle", { newState: "open" });
  await vi.waitFor(() => expect(setItems).toHaveBeenCalled());
  const items = setItems.mock.calls.at(-1)![0];
  expect(new Set(items.map((item: { id: string }) => item.id)).size).toBe(2);
  expect(items.map((item: { fileDiff: { patch: string } }) => item.fileDiff.patch)).toEqual(
    files.map((file) => file.patch),
  );
  wrapper.unmount();
});
