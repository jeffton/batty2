import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, vi } from "vite-plus/test";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { loadConfig } from "./config";
import { loadAppOptions, setDefaultModel, setMemoryModel } from "./options";
import { Runtime, context } from "./runtime";

test("persisted memory selection drives runtime summaries independently of chat defaults", async () => {
  const directory = await mkdtemp(join(tmpdir(), "batty2-memory-model-"));
  vi.stubEnv("PI_OFFLINE", "1");
  vi.stubEnv("BATTY_MEMORY_REASONING", "low");
  vi.stubEnv("BATTY_MEMORY_MODEL", "ignored/obsolete");
  let runtime: Runtime | undefined;
  try {
    await mkdir(join(directory, ".batty"));
    await mkdir(join(directory, "work"));
    await writeFile(
      join(directory, ".batty", "options.json"),
      JSON.stringify({
        workspacesRoots: [directory],
        webPushSubject: "mailto:test@example.com",
      }),
    );
    expect((await loadAppOptions(directory)).memoryModel).toBe("openai-codex/gpt-6-luna");
    await setDefaultModel(directory, "faux", "chat", "high");
    await setMemoryModel(directory, "faux/memory-a");
    const config = { ...(await loadConfig(directory)), selfPath: join(directory, "work") };
    const calls: { model: string; reasoning: string | undefined }[] = [];
    const faux = fauxProvider({ models: [{ id: "chat" }, { id: "memory-a" }, { id: "memory-b" }] });
    const summarize = (
      _request: unknown,
      options: { reasoning?: string } | undefined,
      _state: unknown,
      model: { id: string },
    ) => {
      calls.push({ model: model.id, reasoning: options?.reasoning });
      return fauxAssistantMessage("Short memory summary");
    };
    faux.setResponses(Array.from({ length: 100 }, () => summarize));
    runtime = await Runtime.open(config, {
      resume: false,
      beforeStart: (opened) => {
        opened.models.registerNativeProvider(faux.provider);
      },
    });
    const appendAndBuild = async () => {
      await runtime!.main.commit(
        (tx) =>
          tx.appendEntry(runtime!.main.id, {
            kind: "pi.user",
            model: [{ role: "user", content: "Long source material. ".repeat(1000), timestamp: 1 }],
          }),
        context,
      );
      await runtime!.memory.contextFor(runtime!.main.id, true);
    };
    await appendAndBuild();
    expect(calls.length).toBeGreaterThan(0);
    expect(calls.every((call) => call.model === "memory-a" && call.reasoning === "low")).toBe(true);
    calls.length = 0;
    const settings = await setMemoryModel(directory, "faux/memory-b");
    config.memoryModel = settings.memoryModel;
    await appendAndBuild();
    expect(calls.length).toBeGreaterThan(0);
    expect(calls.every((call) => call.model === "memory-b" && call.reasoning === "low")).toBe(true);
    const persisted = await loadConfig(directory);
    expect(persisted.memoryModel).toBe("faux/memory-b");
    expect(persisted.defaultModel).toBe("chat");
    expect(persisted.defaultThinkingLevel).toBe("high");
  } finally {
    await runtime?.close();
    await rm(directory, { recursive: true, force: true });
    vi.unstubAllEnvs();
  }
}, 15000);
