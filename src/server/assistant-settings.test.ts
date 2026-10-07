import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { changeAssistantWorkspace } from "./assistant-settings";
import { loadConfig } from "./config";
import { loadAppOptions, setAssistantWorkspace, writeStoredOptions } from "./options";

let directory: string;
beforeEach(async () => {
  directory = await fs.mkdtemp(path.join(os.tmpdir(), "batty-assistant-settings-"));
  await fs.mkdir(path.join(directory, "projects", "roy"), { recursive: true });
  await fs.mkdir(path.join(directory, "projects", "project"));
  await writeStoredOptions(directory, {
    workspacesRoots: [path.join(directory, "projects")],
    webPushSubject: "https://example.com",
  });
  await setAssistantWorkspace(directory, "roy");
});
afterEach(async () => {
  await fs.rm(directory, { recursive: true, force: true });
});

function assistant(isStreaming = false, pendingMessageCount = 0) {
  return {
    state: async () => ({ isStreaming, pendingMessageCount }),
    configure: vi.fn(async (_cwd: string) => {}),
  };
}

describe("assistant workspace changes", () => {
  it("updates main cwd and persists the selection while retaining other settings", async () => {
    const config = await loadConfig(directory);
    const before = await loadAppOptions(directory);
    const main = assistant();
    const result = await changeAssistantWorkspace(config, "project", main);
    expect(main.configure).toHaveBeenCalledWith(path.join(directory, "projects", "project"));
    expect(result.workspaces.find((item) => item.isAssistant)?.id).toBe("project");
    expect(await loadAppOptions(directory)).toEqual({ ...before, assistantWorkspaceId: "project" });
  });

  it.each([
    [true, 0],
    [false, 1],
  ])("rejects changes while main has work (%s, %s)", async (streaming, pending) => {
    const config = await loadConfig(directory);
    const main = assistant(streaming, pending);
    await expect(changeAssistantWorkspace(config, "project", main)).rejects.toMatchObject({
      statusCode: 409,
    });
    expect(main.configure).not.toHaveBeenCalled();
    expect((await loadAppOptions(directory)).assistantWorkspaceId).toBe("roy");
  });

  it("does not persist a selection if runtime configuration fails", async () => {
    const config = await loadConfig(directory);
    const main = assistant();
    main.configure.mockRejectedValueOnce(new Error("Configure failed"));
    await expect(changeAssistantWorkspace(config, "project", main)).rejects.toThrow(
      "Configure failed",
    );
    expect((await loadAppOptions(directory)).assistantWorkspaceId).toBe("roy");
  });
});
