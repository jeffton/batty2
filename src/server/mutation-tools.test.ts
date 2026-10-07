import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, test } from "vite-plus/test";
import { createMutationTool } from "./mutation-tools";

test("snapshot operations preserve native @ paths and serialize parallel same-file writes/edits", async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "batty-mutations-"));
  const run = (name: "write" | "edit", args: unknown) =>
    createMutationTool(cwd, name).execute("call", args, undefined, undefined, { cwd } as never);
  try {
    const first = await run("write", { path: "@a.txt", content: "first\n" });
    expect((first.details as any).battyFileChanges[0]).toMatchObject({
      path: path.join(cwd, "a.txt"),
      before: null,
      after: "first\n",
    });
    const results = await Promise.all([
      run("edit", { path: "a.txt", edits: [{ oldText: "first", newText: "second" }] }),
      run("edit", { path: "a.txt", edits: [{ oldText: "second", newText: "third" }] }),
    ]);
    expect((results[0]!.details as any).battyFileChanges[0]).toMatchObject({
      before: "first\n",
      after: "second\n",
    });
    expect((results[1]!.details as any).battyFileChanges[0]).toMatchObject({
      before: "second\n",
      after: "third\n",
    });
  } finally {
    await fs.rm(cwd, { recursive: true, force: true });
  }
});
