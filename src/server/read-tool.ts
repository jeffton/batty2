import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createReadToolDefinition } from "@earendil-works/pi-coding-agent";

/** Native image handling and default truncation, with Batty's explicit-limit semantics. */
export function createBattyReadTool(cwd: string) {
  const native = createReadToolDefinition(cwd);
  return {
    ...native,
    execute: async (...args: Parameters<typeof native.execute>) => {
      const result = await native.execute(...args);
      const [, input] = args;
      if (input.limit === undefined || result.content.some((block) => block.type === "image"))
        return result;
      const inputPath = input.path.startsWith("~/")
        ? path.join(os.homedir(), input.path.slice(2))
        : input.path;
      const content = await fs.readFile(path.resolve(cwd, inputPath), "utf8");
      const lines = content.split("\n");
      const start = Math.max(0, (input.offset ?? 1) - 1);
      const end = Math.min(start + input.limit, lines.length);
      let text = lines.slice(start, end).join("\n");
      if (end < lines.length)
        text += `\n\n[${lines.length - end} more lines in file. Use offset=${end + 1} to continue.]`;
      return { content: [{ type: "text" as const, text }], details: undefined };
    },
  };
}
