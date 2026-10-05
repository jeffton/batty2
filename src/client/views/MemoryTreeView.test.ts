// @vitest-environment happy-dom
import { flushPromises, mount } from "@vue/test-utils";
import { expect, test, vi } from "vite-plus/test";
import MemoryTreeView from "./MemoryTreeView.vue";
import { getMemoryTree, expandMemoryNode } from "@/client/lib/api";

vi.mock("@/client/lib/api", () => ({ getMemoryTree: vi.fn(), expandMemoryNode: vi.fn() }));
const root = {
  id: 0,
  count: 2,
  summary: "Summary",
  bytes: 7,
  startDate: "2026-01-01T00:00:00Z",
  endDate: "2026-01-02T00:00:00Z",
};
test("loads only overview, expands lazily, reads original and collapses with breadcrumbs", async () => {
  vi.mocked(getMemoryTree).mockResolvedValue({ nodes: [root], prepared: 2, total: 2 });
  vi.mocked(expandMemoryNode).mockImplementation(async (_id, count) =>
    count === 2
      ? {
          children: [
            { ...root, count: 1 },
            { ...root, id: 1, count: 1 },
          ],
        }
      : { children: [], text: "0+0|user: exact <script>original</script>" },
  );
  const wrapper = mount(MemoryTreeView, {
    global: { stubs: { RouterLink: { template: "<a><slot /></a>" } } },
  });
  await flushPromises();
  expect(expandMemoryNode).not.toHaveBeenCalled();
  await wrapper.get(".node").trigger("click");
  await flushPromises();
  expect(expandMemoryNode).toHaveBeenCalledWith(0, 2);
  expect(wrapper.findAll(".node")).toHaveLength(2);
  await wrapper.findAll(".node")[0]!.trigger("click");
  await flushPromises();
  expect(wrapper.get("pre").text()).toContain("exact <script>original</script>");
  expect(wrapper.find("pre script").exists()).toBe(false);
  await wrapper.get(".tree-controls button").trigger("click");
  expect(wrapper.findAll(".node")).toHaveLength(2);
  await wrapper.get("nav button").trigger("click");
  expect(wrapper.findAll(".node")).toHaveLength(1);
  expect(expandMemoryNode).toHaveBeenCalledTimes(2);
  wrapper.unmount();
});
