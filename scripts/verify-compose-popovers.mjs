// Run after pnpm build. Native popover placement and compose controls at mobile/desktop sizes.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { chromium } from "patchright";
import mime from "mime-types";

const agent = {
  sessionId: "worker",
  parentSessionId: "main",
  sessionPath: "durable:worker",
  workspaceId: "roy",
  prompt: "Investigate the UI",
  model: "fixture/model",
  thinkingLevel: "medium",
  startedAtMs: Date.now(),
};
const state = {
  id: "main",
  sessionId: "main",
  workspaceId: "roy",
  cwd: "/tmp",
  model: "fixture/model",
  modelLabel: "Fixture",
  thinkingLevel: "medium",
  availableThinkingLevels: ["low", "medium"],
  activeTools: [],
  queuedPrompts: [],
  isStreaming: true,
  memoryPreparation: { pending: 8 },
  pendingMessageCount: 0,
  contextTokens: null,
  contextWindow: null,
  contextPercent: null,
  totalMessageCount: 1,
  hasMoreMessages: false,
  messagesDetailLevel: "full",
  streamId: "compose-fixture",
  revision: 1,
  updatedAt: Date.now(),
  messages: [
    {
      id: "1",
      role: "user",
      timestamp: Date.now(),
      blocks: [{ type: "text", text: "Fixture thread" }],
    },
  ],
};
const streams = new Set();
let activeTasks = true;
function publishMain() {
  state.revision++;
  for (const stream of [...streams].filter((stream) => !stream.worker)) {
    stream.write(
      `data: ${JSON.stringify({ type: "reset", state, streamId: state.streamId, revision: state.revision })}\n\n`,
    );
  }
}
const server = http.createServer(async (request, response) => {
  const url = new URL(request.url, "http://localhost");
  const json = (body) => {
    response.setHeader("Content-Type", "application/json");
    response.end(JSON.stringify(body));
  };
  if (url.pathname === "/api/bootstrap")
    return json({
      authenticated: true,
      cacheScope: "compose-fixture",
      cacheExpiresAt: Date.now() + 86400000,
      auth: { passkeyCount: 1 },
      providerAuth: { providers: [] },
      settings: {
        appearance: { title: "Batty", color: "neutral" },
        defaultThinkingLevel: "medium",
        defaultProvider: "fixture",
        defaultModel: "model",
      },
      models: [
        {
          id: "fixture/model",
          label: "Fixture",
          thinkingLevels: ["low", "medium"],
          supportsImages: true,
          reasoning: true,
          provider: "fixture",
        },
      ],
      workspaces: [
        {
          id: "roy",
          label: "Roy",
          path: "/tmp",
          kind: "workspace",
          isPinned: true,
          isAssistant: true,
        },
      ],
      buildId: "dev",
    });
  if (url.pathname.endsWith("/subagents")) return json(activeTasks ? [agent] : []);
  if (url.pathname.endsWith("/cron-run-logs"))
    return json([
      {
        runId: "cron-running",
        jobId: "job",
        workspaceId: "roy",
        prompt: "Running cron fixture",
        status: activeTasks ? "running" : "success",
        sessionId: "worker",
        startedAtMs: Date.now(),
      },
      {
        runId: "cron-done",
        jobId: "old-job",
        workspaceId: "roy",
        prompt: "Completed cron fixture",
        status: "success",
        startedAtMs: Date.now(),
      },
    ]);
  if (url.pathname === "/api/main" || url.pathname === "/api/sessions/worker")
    return json({
      ...state,
      ...(url.pathname.includes("worker")
        ? {
            id: "worker",
            sessionId: "worker",
            messages: [
              { ...state.messages[0], blocks: [{ type: "text", text: "Worker transcript" }] },
            ],
          }
        : {}),
    });
  if (url.pathname.endsWith("/events")) {
    response.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-store" });
    response.write(
      `data: ${JSON.stringify({ type: "reset", state: url.pathname.includes("worker") ? { ...state, id: "worker", sessionId: "worker", messages: [{ ...state.messages[0], blocks: [{ type: "text", text: "Worker transcript" }] }] } : state, streamId: state.streamId, revision: 1 })}\n\n`,
    );
    response.worker = url.pathname.includes("worker");
    streams.add(response);
    request.on("close", () => streams.delete(response));
    return;
  }
  if (url.pathname === "/api/provider-usage") return json({ windows: [], provider: "fixture" });
  if (url.pathname === "/api/version") return json({ buildId: "dev" });
  if (url.pathname.startsWith("/api/")) return json([]);
  try {
    const file = path.join(
      process.env.CLIENT_DIR ?? "dist/client",
      url.pathname === "/" ? "index.html" : url.pathname,
    );
    response.setHeader("Content-Type", mime.lookup(file) || "application/octet-stream");
    response.end(await fs.readFile(file));
  } catch {
    response.writeHead(404);
    response.end();
  }
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const browser = await chromium.launch({ headless: true });
try {
  for (const width of [320, 390, 1100]) {
    state.isStreaming = true;
    state.revision = 1;
    state.memoryPreparation.pending = 8;
    activeTasks = true;
    const context = await browser.newContext({ viewport: { width, height: 800 } });
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    const agents = page.getByRole("button", { name: "Running tasks", exact: true });
    await agents.waitFor();
    const controls = await page.locator(".composer__actions-row button").evaluateAll((buttons) =>
      buttons.map((button) => {
        const rect = button.getBoundingClientRect();
        return {
          name: button.getAttribute("aria-label"),
          x: rect.x,
          y: rect.y,
          right: rect.right,
          bottom: rect.bottom,
          width: rect.width,
          height: rect.height,
        };
      }),
    );
    for (const control of controls) {
      assert(control.width >= 44 && control.height >= 44, JSON.stringify(control));
      assert(control.x >= 0 && control.right <= width, JSON.stringify(control));
    }
    assert(
      controls.every((control) => control.y === controls[0].y),
      JSON.stringify(controls),
    );
    assert.equal(await agents.textContent().then((text) => text.trim()), "2 tasks");
    assert.equal(await page.locator(".streaming-stop-control__status").count(), 0);
    for (let i = 0; i < controls.length; i++)
      for (let j = i + 1; j < controls.length; j++) {
        const a = controls[i];
        const b = controls[j];
        assert(
          !(a.x < b.right && a.right > b.x && a.y < b.bottom && a.bottom > b.y),
          `Overlapping controls: ${a.name}/${b.name}`,
        );
      }
    const stop = page.getByRole("button", { name: "Stop", exact: true });
    const stopWithTasks = await stop.boundingBox();
    const assertStopPosition = async () => {
      const box = await stop.boundingBox();
      assert(
        Math.abs(box.x - stopWithTasks.x) < 1 && box.y === stopWithTasks.y,
        "Stop button moved with task status",
      );
    };
    activeTasks = false;
    state.memoryPreparation.pending = 0;
    publishMain();
    await agents.waitFor({ state: "hidden" });
    await assertStopPosition();
    state.memoryPreparation.pending = 8;
    publishMain();
    await agents.waitFor();
    await assertStopPosition();
    activeTasks = true;
    await page.waitForTimeout(1700);
    await assertStopPosition();
    assert(await agents.locator(".tasks-control__info strong").isVisible());
    assert(await agents.locator(".tasks-control__spinner").isVisible());
    for (const [opener, selector] of [
      [page.getByRole("button", { name: "Model and thinking", exact: true }), ".mc-popover"],
      [agents, ".tasks-popover"],
    ]) {
      await opener.click();
      const popover = page.locator(`${selector}:popover-open`);
      await popover.waitFor();
      await page.waitForTimeout(100);
      assert.notEqual(
        await popover.evaluate(
          (element) => getComputedStyle(element, "::backdrop").backgroundColor,
        ),
        "rgba(0, 0, 0, 0)",
        "Popover backdrop missing",
      );
      const anchor = await opener.boundingBox();
      const box = await popover.boundingBox();
      assert(box.x >= 7 && box.x + box.width <= width - 7, JSON.stringify({ width, box }));
      assert(
        box.y >= 7 && box.y + box.height <= anchor.y - 7,
        JSON.stringify({ width, anchor, box }),
      );
      assert(box.x <= anchor.x + anchor.width && box.x + box.width >= anchor.x);
      if (selector === ".mc-popover")
        assert(Math.abs(box.x + box.width - (width - 8)) < 1, JSON.stringify({ width, box }));
      if (selector === ".tasks-popover") {
        assert.equal(await popover.getByText("Preparing memory", { exact: true }).count(), 1);
        assert.equal(await popover.getByText("Completed cron fixture", { exact: true }).count(), 0);
        state.isStreaming = false;
        publishMain();
        await page.getByRole("button", { name: "Stop", exact: true }).waitFor({ state: "hidden" });
        await page.waitForTimeout(100);
        const idleAnchor = await opener.boundingBox();
        const idleBox = await popover.boundingBox();
        assert(Math.abs(idleBox.y + idleBox.height - (idleAnchor.y - 8)) < 1);
        assert(
          idleBox.x <= idleAnchor.x + idleAnchor.width && idleBox.x + idleBox.width >= idleAnchor.x,
        );
        const row = await popover.locator(".tasks-popover__task").first().boundingBox();
        assert(row.height > 44);
        await page.screenshot({ path: `/tmp/batty2-compose-${width}.png` });
        await popover
          .getByRole("button", { name: "Open task session: Running cron fixture" })
          .click();
        await page.getByText("Worker transcript", { exact: true }).waitFor();
        assert.equal(
          await popover.isVisible(),
          false,
          "Tasks list stayed open when session opened",
        );
        activeTasks = false;
        state.memoryPreparation.pending = 0;
        publishMain();
        await page.waitForTimeout(2000);
        assert(
          await page.getByText("Worker transcript", { exact: true }).isVisible(),
          "Completed task transcript disappeared",
        );
        assert.equal(await agents.isVisible(), false);
        await page.keyboard.press("Escape");
        activeTasks = true;
        await agents.waitFor();
        await agents.click();
        await page.waitForTimeout(100);
        activeTasks = false;
        await page.waitForTimeout(2000);
        assert.equal(await agents.textContent().then((text) => text.trim()), "0 tasks");
        assert(await popover.getByText("No running tasks.", { exact: true }).isVisible());
        await page.keyboard.press("Escape");
        await agents.waitFor({ state: "hidden" });
        assert.deepEqual(errors, []);
      } else {
        await page.setViewportSize({ width, height: 400 });
        await page.waitForTimeout(100);
        const resizedAnchor = await opener.boundingBox();
        const resizedBox = await popover.boundingBox();
        assert(resizedBox.y >= 7 && resizedBox.y + resizedBox.height <= resizedAnchor.y - 7);
        assert(resizedBox.x >= 7 && resizedBox.x + resizedBox.width <= width - 7);
        await page.keyboard.press("Escape");
        await page.setViewportSize({ width, height: 800 });
      }
    }
    await page.keyboard.press("Escape");
    await page.getByRole("button", { name: "Cron", exact: true }).click();
    const tabs = page.locator(".cron-popover__tabs [role=tab]");
    assert.deepEqual(
      (await tabs.allTextContents()).map((text) => text.trim()),
      ["Cron", "Logs"],
    );
    console.log(JSON.stringify({ width, controls, result: "compose popovers passed" }));
    await context.close();
  }
} finally {
  await browser.close();
  for (const response of streams) response.end();
  await new Promise((resolve) => server.close(resolve));
}
