import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vite-plus/test";
import { loadConfig } from "./config";
import { setAssistantWorkspace, writeStoredOptions } from "./options";
import { createResources } from "./resources";
import { listWorkspaces } from "./workspaces";

let directory: string;
beforeEach(async () => {
  directory = await mkdtemp(path.join(tmpdir(), "batty2-resources-"));
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(async () => {
  vi.restoreAllMocks();
  await rm(directory, { recursive: true, force: true });
});

async function skill(workspace: string, name: string, description = name) {
  const folder = path.join(workspace, ".batty", "skills", name);
  await mkdir(folder, { recursive: true });
  const filePath = path.join(folder, "SKILL.md");
  await writeFile(
    filePath,
    `---\nname: ${name}\ndescription: ${description}\n---\nSkill instructions.\n`,
  );
  return filePath;
}

async function setup(roots: string[], assistantWorkspaceId?: string) {
  const battyDir = path.join(directory, "state");
  await writeStoredOptions(battyDir, {
    workspacesRoots: roots,
    assistantWorkspaceId,
    webPushSubject: "mailto:test@example.com",
  });
  return loadConfig(battyDir);
}

test("popover skills include global, execution and configured assistant workspaces with original file paths", async () => {
  const root = path.join(directory, "workspaces");
  const current = path.join(root, "project");
  const assistant = path.join(root, "assistant");
  const other = path.join(root, "other");
  const currentFile = await skill(current, "project-skill");
  const assistantFile = await skill(assistant, "assistant-skill");
  const otherFile = await skill(other, "other-skill");
  const config = await setup([root], "assistant");
  const globalFile = await skill(config.battyDir, "global-skill");
  const resources = createResources(config);

  expect((await resources.sessionSkills(current)).map((entry) => entry.filePath)).toEqual([
    globalFile,
    currentFile,
    assistantFile,
  ]);
  // Prompt resources retain their existing execution-workspace scope.
  expect(resources.skills(current).map((entry) => entry.filePath)).toEqual([
    globalFile,
    currentFile,
  ]);
  await setAssistantWorkspace(config.battyDir, "other");
  expect((await resources.sessionSkills(current)).map((entry) => entry.filePath)).toEqual([
    globalFile,
    currentFile,
    otherFile,
  ]);
  await setAssistantWorkspace(config.battyDir, undefined);
  expect((await resources.sessionSkills(current)).map((entry) => entry.filePath)).toEqual([
    globalFile,
    currentFile,
  ]);
});

test("assistant workspace IDs resolve across multiple roots, not as folder names", async () => {
  const roots = [path.join(directory, "first"), path.join(directory, "second")];
  const current = path.join(roots[0]!, "project");
  await skill(current, "project-skill");
  await skill(path.join(roots[0]!, "assistant"), "wrong-assistant");
  const assistant = path.join(roots[1]!, "assistant");
  const assistantFile = await skill(assistant, "selected-assistant");
  const config = await setup(roots);
  const selected = (await listWorkspaces(config)).find(
    (workspace) => workspace.path === assistant,
  )!;
  await setAssistantWorkspace(config.battyDir, selected.id);

  expect((await createResources(config).sessionSkills(current)).map((entry) => entry.name)).toEqual(
    ["project-skill", "selected-assistant"],
  );
  expect((await createResources(config).sessionSkills(current))[1]!.filePath).toBe(assistantFile);
});

test("duplicate directories, symlinked files and skill names preserve existing source precedence", async () => {
  const root = path.join(directory, "workspaces");
  const current = path.join(root, "project");
  const assistant = path.join(root, "assistant");
  const currentFile = await skill(current, "current-wins");
  const sharedFile = await skill(current, "shared");
  await skill(assistant, "current-wins", "assistant collision");
  await symlink(path.dirname(sharedFile), path.join(assistant, ".batty", "skills", "shared-link"));
  const config = await setup([root], "assistant");
  const globalFile = await skill(config.battyDir, "global-wins");
  await skill(current, "global-wins", "current collision");
  await skill(assistant, "global-wins", "assistant collision");
  const resources = createResources(config);

  const loaded = await resources.sessionSkills(current);
  expect(loaded.map((entry) => entry.filePath).sort()).toEqual(
    [globalFile, currentFile, sharedFile].sort(),
  );
  await setAssistantWorkspace(config.battyDir, "project");
  console.warn = vi.fn();
  expect((await resources.sessionSkills(current)).map((entry) => entry.filePath).sort()).toEqual(
    loaded.map((entry) => entry.filePath).sort(),
  );
  expect(console.warn).toHaveBeenCalledTimes(1); // Only the real global/current name collision.
});
