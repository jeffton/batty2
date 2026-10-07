import fs from "node:fs/promises";
import { constants } from "node:fs";
import {
  createEditToolDefinition,
  createWriteToolDefinition,
  generateUnifiedPatch,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type { DurableFileChange } from "./agent-turn-file-changes";

/** Capture inside native tool operations, while Pi holds its per-file mutation queue. */
export function createMutationTool(cwd: string, name: "write" | "edit"): ToolDefinition<any> {
  let before: string | null;
  let mutation: DurableFileChange | undefined;
  const writeFile = async (absolutePath: string, content: string) => {
    if (name === "write") {
      before = await fs.readFile(absolutePath, "utf8").catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return null;
        throw error;
      });
    }
    await fs.writeFile(absolutePath, content, "utf8");
    mutation = {
      path: absolutePath,
      order: performance.timeOrigin + performance.now(),
      before,
      after: content,
      patch: generateUnifiedPatch(absolutePath, before ?? "", content),
    };
  };
  const definition =
    name === "write"
      ? createWriteToolDefinition(cwd, {
          operations: {
            writeFile,
            mkdir: async (dir) => {
              await fs.mkdir(dir, { recursive: true });
            },
          },
        })
      : createEditToolDefinition(cwd, {
          operations: {
            writeFile,
            readFile: async (absolutePath) => {
              const buffer = await fs.readFile(absolutePath);
              before = buffer.toString("utf8");
              return buffer;
            },
            access: async (absolutePath) => {
              await fs.access(absolutePath, constants.R_OK | constants.W_OK);
            },
          },
        });
  return {
    name: definition.name,
    label: definition.label,
    description: definition.description,
    parameters: definition.parameters,
    promptSnippet: definition.promptSnippet,
    promptGuidelines: definition.promptGuidelines,
    execute: async (...args) => {
      const result = await (definition as ToolDefinition<any, any>).execute(...args);
      return {
        ...result,
        details: { ...result.details, ...(mutation ? { battyFileChanges: [mutation] } : {}) },
      };
    },
  };
}
