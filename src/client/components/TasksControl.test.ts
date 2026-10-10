import { describe, expect, it } from "vite-plus/test";
import { mount } from "@vue/test-utils";
import TasksControl from "./TasksControl.vue";
import type { CronRunLog, RunningSubagent } from "@/shared/types";

const agent = {
  sessionId: "agent",
  prompt: "Research",
  workspaceId: "roy",
  model: "model",
  thinkingLevel: "low",
} as RunningSubagent;
const run = {
  runId: "run",
  sessionId: "cron",
  prompt: "Publish news",
  workspaceId: "roy",
  status: "running",
} as CronRunLog;

describe("compose tasks", () => {
  it("combines memory, running cron and subagents without completed or duplicate sessions", async () => {
    const wrapper = mount(TasksControl, {
      props: {
        memoryPending: 3,
        subagents: [agent, { ...agent, sessionId: "cron" }],
        cronRuns: [run, { ...run, runId: "done", status: "success" }],
      },
      global: {
        stubs: { BasePopover: { template: "<div><slot /></div>" }, SubagentSessionPopover: true },
      },
    });
    try {
      expect(wrapper.get(".tasks-control").text()).toBe("3 tasks");
      const rows = wrapper.findAll(".tasks-popover__task");
      expect(rows.map((row) => row.get("strong").text())).toEqual([
        "Preparing memory",
        "Publish news",
        "Research",
      ]);
      expect(wrapper.get(".tasks-popover__header").text()).toBe("Running tasks");
      expect(rows[0]!.find("button").exists()).toBe(false);
      expect(rows[1]!.get("button").attributes("popovertarget")).toContain("cron-run");
      expect(rows[2]!.get("button").attributes("popovertarget")).toContain("agent-agent");
      expect(rows[2]!.get("button").attributes("aria-label")).toBe("Open task session: Research");
      await wrapper.setProps({
        memoryPending: 0,
        subagents: [],
        cronRuns: [{ ...run, status: "success" }],
      });
      expect(wrapper.find(".tasks-control").exists()).toBe(false);
      expect(wrapper.text()).toContain("No running tasks.");
    } finally {
      wrapper.unmount();
    }
  });
});
