import fs from "node:fs/promises";
import path from "node:path";
import { loadSkills, formatSkillsForPrompt } from "@earendil-works/pi-coding-agent";
import { defineExtension, section } from "@earendil-works/pi-durable";
import type { AppConfig } from "./config";
import { stateDirPath } from "./options";

export function createResources(config: AppConfig) {
  const agentDir = stateDirPath(config.battyDir);
  function skills(cwd: string) {
    const result = loadSkills({
      cwd,
      agentDir,
      skillPaths: [path.join(agentDir, "skills"), path.join(cwd, ".batty", "skills")],
      includeDefaults: false,
    });
    for (const diagnostic of result.diagnostics) console.warn("Skill diagnostic", diagnostic);
    return result.skills;
  }
  async function instructions(cwd: string) {
    const files = [path.join(agentDir, "AGENTS.md"), path.join(cwd, "AGENTS.md")];
    const texts: string[] = [];
    for (const file of [...new Set(files)]) {
      try {
        texts.push(await fs.readFile(file, "utf8"));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
    return texts.join("\n\n");
  }
  return {
    skills,
    extension: defineExtension({
      name: "batty-resources",
      sections: [
        section(
          "assistant",
          () =>
            "You are Batty, a personal assistant with one permanent main thread. Delegate focused work to subagents in its target workspace. Every asynchronous subagent and cron report is delivered to the main thread. Workspaces are execution scopes, never separate user chats. Do not send messages or publish externally on the user's behalf unless explicitly asked. Ask for explicit approval before submitting forms, booking, or purchasing. Use tools to complete tasks yourself. For work on Batty2, source is /root/github/batty2 and deployment is scripts/deploy.sh; use the new batty2.service, never the original batty.service.",
        ),
        section("cwd", (input) => input.agent.cwd),
        section("skills", (input) =>
          formatSkillsForPrompt(skills(input.agent.cwd ?? config.selfPath)),
        ),
        section("user-instructions", (input) => instructions(input.agent.cwd ?? config.selfPath)),
      ],
    }),
  };
}
