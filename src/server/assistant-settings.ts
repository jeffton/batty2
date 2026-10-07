import type { AppConfig } from "./config";
import { setAssistantWorkspace } from "./options";
import { listWorkspaces } from "./workspaces";

export async function changeAssistantWorkspace(
  config: AppConfig,
  workspaceId: string,
  assistant: {
    state(): Promise<{ isStreaming: boolean; pendingMessageCount: number }>;
    configure(cwd: string): Promise<void>;
  },
) {
  const workspaces = await listWorkspaces(config);
  const workspace = workspaces.find((item) => item.id === workspaceId);
  if (!workspace) throw Object.assign(new Error("Unknown workspace"), { statusCode: 400 });
  const state = await assistant.state();
  if (state.isStreaming || state.pendingMessageCount) {
    throw Object.assign(new Error("Wait until the assistant is idle to change workspace"), {
      statusCode: 409,
    });
  }
  await assistant.configure(workspace.path);
  await setAssistantWorkspace(config.battyDir, workspace.id);
  return { workspaces: await listWorkspaces(config) };
}
