// @vitest-environment node
import { expect, test } from "vite-plus/test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { once } from "node:events";
import { BrowserService } from "./browser-service";
import { browserSessionDirectory } from "./browser-persistence";

test("browser service detach/reconnect preserves tabs, cookies, JavaScript state and tab/frame IDs", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "batty-browser-restart-"));
  const server = http.createServer((request, response) =>
    response.end(
      request.url === "/frame"
        ? "<html><body>Frame</body></html>"
        : '<html><body><h1>Persistent tab</h1><iframe src="/frame"></iframe></body></html>',
    ),
  );
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/`;
  let service = new BrowserService(undefined, 4, root);
  try {
    const first = await service.execute("durable", { action: "open", url });
    const pageId = first.details.pageId!;
    const beforeFrames = await service.execute("durable", { action: "frames", pageId });
    await service.execute("durable", {
      action: "evaluate",
      pageId,
      script:
        'globalThis.liveState = {counter: 42}; document.cookie = "durableCookie=present; path=/"; "saved"',
    });
    const second = await service.execute("durable", { action: "open", url, newPage: true });
    await service.execute("durable", { action: "switch", pageId });
    await service.dispose();
    // Recover even if the original service died before saving its endpoint/PID
    // receipt: Chromium's profile lock and DevToolsActivePort are authoritative.
    const directory = browserSessionDirectory(root, "durable");
    await fs.rm(path.join(directory, "browser.json"));
    await fs.rm(path.join(directory, "process.json"));
    service = new BrowserService(undefined, 4, root);
    const pages = await service.execute("durable", { action: "pages" });
    expect(pages.details.pages?.map((page) => page.id).sort()).toEqual(
      [pageId, second.details.pageId!].sort(),
    );
    expect(pages.details.pages?.find((page) => page.active)?.id).toBe(pageId);
    const state = await service.execute("durable", {
      action: "evaluate",
      pageId,
      script: "({state: globalThis.liveState, cookies: document.cookie})",
    });
    expect(state.text).toContain("42");
    expect(state.text).toContain("durableCookie=present");
    const afterFrames = await service.execute("durable", { action: "frames", pageId });
    expect(afterFrames.details.frames?.map((frame) => frame.id)).toEqual(
      beforeFrames.details.frames?.map((frame) => frame.id),
    );
    const controller = new AbortController();
    const began = Date.now();
    const waiting = service.execute(
      "durable",
      { action: "evaluate", pageId, script: "new Promise(() => {})" },
      controller.signal,
    );
    const cancelled = waiting.then(
      () => "completed",
      () => "aborted",
    );
    setTimeout(() => controller.abort(new Error("cancelled")), 50);
    expect(await cancelled).toBe("aborted");
    expect(Date.now() - began).toBeLessThan(500);
    const disposing = Date.now();
    await service.dispose();
    expect(Date.now() - disposing).toBeLessThan(1000);
    service = new BrowserService(undefined, 4, root);
    expect(
      (
        await service.execute("durable", {
          action: "evaluate",
          pageId,
          script: "globalThis.liveState.counter",
        })
      ).text,
    ).toContain("42");
    const stuck = service
      .execute("durable", { action: "evaluate", pageId, script: "new Promise(() => {})" })
      .then(
        () => "completed",
        () => "closed",
      );
    await new Promise((resolve) => setTimeout(resolve, 50));
    const closing = Date.now();
    await service.execute("durable", { action: "close" });
    expect(Date.now() - closing).toBeLessThan(6000);
    expect(await stuck).toBe("closed");
    expect(await fs.readdir(root)).toEqual([]);
  } finally {
    await service.closeSession("durable");
    await service.dispose();
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    await fs.rm(root, { recursive: true, force: true });
  }
}, 30_000);
