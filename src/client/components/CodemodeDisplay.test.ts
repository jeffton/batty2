import { mount } from "@vue/test-utils";
import { describe, expect, it } from "vite-plus/test";
import CodemodeDisplay from "./CodemodeDisplay.vue";
import type { CodemodeCall } from "@/shared/types";

// Runtime details.calls schema, including preserved nested task faults.
const calls: CodemodeCall[] = [
  {
    id: "call-0",
    name: "read",
    args: '{"path":"present.txt"}',
    status: "ok",
    durationMs: 12,
    details: null,
  },
  {
    id: "call-1",
    name: "read",
    args: '{"path":"missing.txt"}',
    status: "error",
    durationMs: 34,
    error: "ENOENT: missing.txt",
    details: null,
  },
];

describe("codemode runtime call display", () => {
  it("renders successful and faulted calls, arguments, timing and expanded errors", async () => {
    const wrapper = mount(CodemodeDisplay, {
      props: {
        code: "await Promise.allSettled([])",
        blocks: [],
        details: { calls },
        compact: false,
        status: "success",
      },
      global: { stubs: { CodeBlock: true, SubagentSessionPopover: true } },
    });
    expect(wrapper.findAll(".codemode-display__call")).toHaveLength(2);
    expect(wrapper.text()).toContain('{"path":"present.txt"}');
    expect(wrapper.text()).toContain('{"path":"missing.txt"}');
    expect(wrapper.text()).toContain("12ms");
    expect(wrapper.find('[aria-label="ok"]').exists()).toBe(true);
    expect(wrapper.find('[aria-label="error"]').exists()).toBe(true);
    await wrapper.get(".tool-call__expand-btn").trigger("click");
    expect(wrapper.get(".codemode-display__error").text()).toBe("ENOENT: missing.txt");
    await wrapper.setProps({
      details: {
        calls: [
          {
            id: "call-2",
            name: "read",
            args: "undefined",
            status: "error",
            error: "Invalid arguments for read",
            durationMs: 1,
          },
        ],
      },
    });
    expect(wrapper.text()).toContain("undefined");
    expect(wrapper.get(".codemode-display__error").text()).toBe("Invalid arguments for read");
  });
});
