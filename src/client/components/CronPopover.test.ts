import { flushPromises, mount } from "@vue/test-utils";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import CronPopover from "./CronPopover.vue";
import * as api from "@/client/lib/api";
import type { CronJob, CronRunLog, RunningSubagent } from "@/shared/types";

vi.mock("@/client/lib/api", () => ({
  listRunningSubagents: vi.fn(),
  listWorkspaceCronJobs: vi.fn(),
  listWorkspaceCronRunLogs: vi.fn(),
}));
vi.mock("@/client/stores/app", () => ({
  useAppStore: () => ({
    activeSession: { id: "main" },
    selectedWorkspaceId: "first",
    workspaces: [
      { id: "first", label: "First workspace" },
      { id: "second", label: "Second workspace" },
    ],
  }),
}));

function job(workspaceId: string): CronJob {
  return {
    id: workspaceId,
    workspaceId,
    prompt: `Job in ${workspaceId}`,
    enabled: true,
    model: "provider/model",
    thinkingLevel: "medium",
    schedule: { kind: "every", every: "1h" },
    scheduleLabel: "Every 1h",
    session: { kind: "daily-detached" },
    createdAt: 0,
    updatedAt: 0,
    state: {},
  };
}

afterEach(() => vi.clearAllMocks());

describe("cron and subagents popover", () => {
  it("lists jobs and logs from every workspace and opens worker/run sessions with icon buttons", async () => {
    const agent: RunningSubagent = {
      sessionId: "worker-session",
      sessionPath: "durable:worker-session",
      parentSessionId: "main",
      workspaceId: "second",
      prompt: "A lengthy worker prompt\nwith more instructions",
      model: "provider/model",
      thinkingLevel: "medium",
      startedAtMs: 1000,
    };
    const run: CronRunLog = {
      runId: "run-second",
      jobId: "second",
      workspaceId: "second",
      prompt: "Job in second",
      model: "provider/model",
      thinkingLevel: "medium",
      session: { kind: "daily-detached" },
      scheduleLabel: "Every 1h",
      startedAtMs: 2000,
      status: "success",
      sessionId: "cron-session",
    };
    vi.mocked(api.listRunningSubagents).mockResolvedValue([agent]);
    vi.mocked(api.listWorkspaceCronJobs).mockImplementation(async (id) => [job(id)]);
    vi.mocked(api.listWorkspaceCronRunLogs).mockImplementation(async (id) =>
      id === "second" ? [run] : [],
    );
    const wrapper = mount(CronPopover, {
      props: { popoverId: "cron-test", anchorName: "--cron" },
      global: {
        stubs: {
          FullPopover: {
            name: "FullPopover",
            template: '<div><slot name="header-content" /><slot /></div>',
          },
          SubagentSessionPopover: true,
        },
      },
    });
    try {
      wrapper.getComponent({ name: "FullPopover" }).vm.$emit("toggle", { newState: "open" });
      await flushPromises();
      expect(api.listWorkspaceCronJobs).toHaveBeenCalledWith("first");
      expect(api.listWorkspaceCronJobs).toHaveBeenCalledWith("second");
      expect(api.listWorkspaceCronRunLogs).toHaveBeenCalledWith("second");
      expect(wrapper.findAll('[role="tab"]').map((tab) => tab.text())).toEqual([
        "Cron",
        "Subagents",
        "Logs",
      ]);
      const cronPanel = wrapper.get("#cron-test-cron-panel");
      expect(cronPanel.text()).toContain("Job in first");
      expect(cronPanel.text()).toContain("Job in second");
      expect(cronPanel.text()).toContain("Second workspace");
      await wrapper.get("#cron-test-subagents-tab").trigger("click");
      expect(cronPanel.attributes("style")).toContain("display: none");
      expect((wrapper.get("#cron-test-subagents-panel").element as HTMLElement).style.display).toBe(
        "",
      );
      expect(
        wrapper.get('button[aria-label="Open subagent session"]').attributes("popovertarget"),
      ).toBe("cron-test-worker-worker-session");
      expect(wrapper.get('button[aria-label="Open subagent session"]').text()).toBe("");
      await wrapper.get("#cron-test-subagents-tab").trigger("keydown", { key: "ArrowRight" });
      expect(wrapper.get("#cron-test-logs-tab").attributes("aria-selected")).toBe("true");
      expect(wrapper.get("#cron-test-logs-panel").text()).toContain("Completed");
      expect(
        wrapper.get('button[aria-label="Open cron run session"]').attributes("popovertarget"),
      ).toBe("cron-test-cron-run-second");
      expect(
        wrapper
          .findAllComponents({ name: "SubagentSessionPopover" })
          .map((popover) => popover.props("sessionId")),
      ).toEqual(["worker-session", "cron-session"]);
    } finally {
      wrapper.unmount();
    }
  });
});
