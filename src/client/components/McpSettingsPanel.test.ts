import { flushPromises, mount } from "@vue/test-utils";
import { expect, it, vi } from "vite-plus/test";
import McpSettingsPanel from "./McpSettingsPanel.vue";
import * as api from "@/client/lib/api";

vi.mock("@/client/lib/api", () => ({
  getMcpSettings: vi.fn(async () => ({ servers: [], errors: [] })),
  getMcpStatus: vi.fn(async () => ({ servers: [], errors: [] })),
  saveMcpServer: vi.fn(async () => ({ servers: [], errors: [] })),
  removeMcpServer: vi.fn(),
  reconnectMcpServer: vi.fn(),
  logoutMcpServer: vi.fn(),
  startMcpLogin: vi.fn(),
  getMcpAuthAttempt: vi.fn(),
  completeMcpAuthAttempt: vi.fn(),
  cancelMcpAuthAttempt: vi.fn(),
}));

it("adds a shared server without a workspace or scope selector", async () => {
  const wrapper = mount(McpSettingsPanel, { props: { active: true } });
  await flushPromises();
  expect(api.getMcpSettings).toHaveBeenCalledWith();
  expect(api.getMcpStatus).toHaveBeenCalledWith();
  await wrapper.get("button.mcp-settings__add").trigger("click");
  expect(wrapper.find('input[aria-label="Global server"]').exists()).toBe(false);
  expect(wrapper.find('[role="switch"]').exists()).toBe(false);
  await wrapper.get('input[aria-label="MCP server name"]').setValue("shared");
  await wrapper
    .get('textarea[aria-label="MCP server configuration"]')
    .setValue('{"command":"server"}');
  await wrapper.get("form").trigger("submit");
  await flushPromises();
  expect(api.saveMcpServer).toHaveBeenCalledWith("shared", {
    command: "server",
    exposure: "codemode",
  });
  wrapper.unmount();
});
