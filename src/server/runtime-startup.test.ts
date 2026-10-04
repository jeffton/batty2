import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, vi } from "vite-plus/test";
import { fauxAssistantMessage, fauxProvider, fauxText } from "@earendil-works/pi-ai/providers/faux";
import { loadConfig } from "./config";
import { Runtime, context } from "./runtime";
import { OrchestrationDoc } from "./orchestration";

test("startup observers see a due inline cron reply even with explicit resume disabled", async () => {
  const directory = await mkdtemp(join(tmpdir(), "batty2-startup-"));
  vi.stubEnv("PI_OFFLINE", "1");
  await mkdir(join(directory, ".batty"));
  await mkdir(join(directory, "work"));
  await writeFile(
    join(directory, ".batty", "options.json"),
    JSON.stringify({
      workspacesRoots: [directory],
      webPushSubject: "mailto:test@example.com",
    }),
  );
  const config = {
    ...(await loadConfig(directory)),
    selfPath: join(directory, "work"),
    workspacesRoots: [directory],
    defaultProvider: "faux",
    defaultModel: "startup-test",
  };
  const faux = fauxProvider({ models: [{ id: "startup-test" }] });
  faux.setResponses([fauxAssistantMessage([fauxText("startup cron reply")])]);
  let runtime: Runtime | undefined;
  let stop: (() => void) | undefined;
  const observed: string[] = [];
  try {
    runtime = await Runtime.open(config, { resume: false });
    const job = await runtime.orchestration.addJob({
      prompt: "startup cron task",
      session: { kind: "main-inline" },
      schedule: { kind: "at", in: "1h" },
    });
    await runtime.main.commit(async (tx) => {
      (await tx.doc(OrchestrationDoc)).jobs[job.id]!.nextAt = Date.now() - 1;
    }, context);
    await runtime.close();
    runtime = undefined;
    runtime = await Runtime.open(config, {
      resume: false,
      beforeStart: (opened) => {
        opened.models.registerNativeProvider(faux.provider);
        stop = opened.harness.subscribeCommits((publication) => {
          for (const change of publication.changes) {
            if (change.type !== "entry") continue;
            for (const message of change.value.model ?? []) {
              if (message.role !== "assistant") continue;
              observed.push(
                ...message.content.flatMap((part) => (part.type === "text" ? [part.text] : [])),
              );
            }
          }
        });
      },
    });
    for (let i = 0; i < 1000; i++) {
      if ((await runtime.orchestration.listRunLogs())[0]?.status === "completed") break;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    expect((await runtime.orchestration.listRunLogs())[0]?.status).toBe("completed");
    expect(observed).toContain("startup cron reply");
  } finally {
    stop?.();
    await runtime?.close();
    await rm(directory, { recursive: true, force: true });
    vi.unstubAllEnvs();
  }
}, 15000);
