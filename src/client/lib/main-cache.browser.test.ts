// @vitest-environment node
import path from "node:path";
import { chromium, webkit, type Browser, type Page } from "playwright-core";
import { createServer, type ViteDevServer } from "vite";
import { afterAll, beforeAll, expect, test } from "vite-plus/test";

let browser: Browser;
let safari: Browser;
let server: ViteDevServer;
let url: string;
const evaluate = <T>(page: Page, fn: () => T) => page.evaluate(fn);
async function fixture(context = browser) {
  const page = await context.newPage();
  await page.goto(url);
  await page.waitForFunction(() => Boolean((window as any).cache));
  return page;
}
beforeAll(async () => {
  server = await createServer({
    configFile: false,
    cacheDir: path.resolve("node_modules/.vite-main-cache-tests"),
    resolve: { alias: { "@": path.resolve("src") } },
    server: { host: "127.0.0.1", port: 0 },
  });
  await server.listen();
  url = `${server.resolvedUrls!.local[0]}src/client/lib/MainCache.fixture.html`;
  browser = await chromium.launch({ headless: true });
  safari = await webkit.launch({ headless: true });
}, 30_000);
afterAll(async () => {
  await browser?.close();
  await safari?.close();
  await server?.close();
});

test("native cache upserts IDs, rejects stale state, isolates users/workers and expires", async () => {
  const page = await fixture();
  const result = await evaluate(page, async () => {
    const c = (window as any).cache;
    const bootstrap = { authenticated: true, cacheScope: "a", cacheExpiresAt: Date.now() + 60_000 };
    const message = (id: string, text: string) => ({
      id,
      role: "user",
      timestamp: Date.now(),
      blocks: [{ type: "text", text }],
    });
    const session = {
      id: "1",
      sessionId: "1",
      streamId: "g",
      revision: 1,
      messages: [message("100", "old")],
      totalMessageCount: 1,
      activeTools: [],
    };
    await c.saveMainCache(bootstrap, c.reactive({ ...session, activeTools: [{ blocks: [] }] }));
    await c.saveMainCache(bootstrap, {
      ...session,
      revision: 3,
      messages: [message("100", "updated"), message("101", "new")],
    });
    await c.saveMainCache(bootstrap, { ...session, revision: 2 });
    const restored = await c.readMainCache();
    await c.saveMainCache(
      { ...bootstrap, cacheScope: "b" },
      { ...session, messages: [message("200", "other")] },
    );
    await c.saveMainCache(bootstrap, { ...session, isSubagentSession: true });
    const other = await c.readMainCache();
    const multi = Array.from({ length: 12 }, (_, i) => message(i ? `300:${i}` : "300", String(i)));
    await c.saveMainCache(bootstrap, { ...session, revision: 4, messages: multi });
    const ordered = await c.readMainCache();
    await c.clearMainCache();
    c.registerMainCacheBootstrap();
    await c.saveMainCache({ ...bootstrap, cacheExpiresAt: Date.now() - 1 }, session);
    return { restored, other, ordered, expired: await c.readMainCache() };
  });
  expect(result.restored.session.messages).toHaveLength(2);
  expect(result.restored.session.messages[0].blocks[0].text).toBe("updated");
  expect(result.restored.session.revision).toBe(3);
  expect(result.other.session.messages.map((m: any) => m.id)).toEqual(["200"]);
  expect(result.ordered.session.messages.map((m: any) => m.id)).toEqual([
    "300",
    ...Array.from({ length: 11 }, (_, i) => `300:${i + 1}`),
  ]);
  expect(result.expired).toBeUndefined();
  await page.close();
});

test("eviction protects 24h before optional history and has a hard bound", async () => {
  const page = await fixture();
  const result = await evaluate(page, () => {
    const c = (window as any).cache;
    const now = Date.now();
    const row = (id: number, hours: number, bytes: number) => ({
      id: String(id),
      timestamp: now - hours * 3_600_000,
      bytes,
      json: "{}",
    });
    return {
      optional: c
        .retainCacheRecords(
          [row(1, 200, 1), row(2, 48, c.CACHE_BYTE_BUDGET), row(3, 12, c.CACHE_BYTE_BUDGET)],
          now,
        )
        .map((r: any) => r.id),
      recent: c.retainCacheRecords(
        [row(4, 12, c.CACHE_BYTE_BUDGET), row(5, 1, c.CACHE_BYTE_BUDGET)],
        now,
      ).length,
      hard: (() => {
        try {
          c.retainCacheRecords(
            Array.from({ length: 5 }, (_, i) => row(i + 10, 1, c.CACHE_BYTE_BUDGET)),
            now,
          );
        } catch (error) {
          return String(error);
        }
      })(),
    };
  });
  expect(result.optional).toEqual(["3"]);
  expect(result.recent).toBe(2);
  expect(result.hard).toContain("128 MiB");
  await page.close();
});

test("logout in another tab cannot be undone by stale cache persistence", async () => {
  const context = await browser.newContext();
  const first = await context.newPage();
  const second = await context.newPage();
  for (const page of [first, second]) {
    await page.goto(url);
    await page.waitForFunction(() => Boolean((window as any).cache));
  }
  const seed = () =>
    (window as any).cache.saveMainCache(
      { cacheScope: "shared", cacheExpiresAt: Date.now() + 60_000 },
      {
        id: "1",
        sessionId: "1",
        messages: [
          {
            id: "1",
            role: "user",
            timestamp: Date.now(),
            blocks: [{ type: "text", text: "private" }],
          },
        ],
        activeTools: [],
      },
    );
  await evaluate(second, seed);
  await evaluate(first, () => (window as any).cache.clearMainCache());
  await evaluate(second, seed);
  expect(await evaluate(second, () => (window as any).cache.readMainCache())).toBeUndefined();
  await context.close();
});

test("cross-tab revision checks and commits are serialized", async () => {
  const context = await browser.newContext();
  const first = await context.newPage();
  const second = await context.newPage();
  for (const page of [first, second]) {
    await page.goto(url);
    await page.waitForFunction(() => Boolean((window as any).cache));
  }
  const revisionThree = () =>
    (window as any).cache.saveMainCache(
      { cacheScope: "same-user", cacheExpiresAt: Date.now() + 60_000 },
      {
        id: "1",
        sessionId: "1",
        streamId: "a",
        revision: 3,
        messages: [
          {
            id: "1",
            role: "user",
            timestamp: Date.now(),
            blocks: [{ type: "text", text: "newer" }],
          },
        ],
        activeTools: [],
      },
    );
  const revisionTwo = () =>
    (window as any).cache.saveMainCache(
      { cacheScope: "same-user", cacheExpiresAt: Date.now() + 60_000 },
      {
        id: "1",
        sessionId: "1",
        streamId: "a",
        revision: 2,
        messages: [
          {
            id: "1",
            role: "user",
            timestamp: Date.now(),
            blocks: [{ type: "text", text: "older" }],
          },
        ],
        activeTools: [],
      },
    );
  await Promise.all([evaluate(first, revisionThree), evaluate(second, revisionTwo)]);
  const restored = await evaluate(first, () => (window as any).cache.readMainCache());
  expect(restored.session.revision).toBe(3);
  expect(restored.session.messages[0].blocks[0].text).toBe("newer");
  await context.close();
});

test("quota error aborts the native transaction and keeps the previous complete cache", async () => {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto(url);
  await page.waitForFunction(() => Boolean((window as any).cache));
  await evaluate(page, () =>
    (window as any).cache.saveMainCache(
      { cacheScope: "quota", cacheExpiresAt: Date.now() + 60_000 },
      {
        id: "1",
        sessionId: "1",
        revision: 1,
        streamId: "a",
        messages: [
          {
            id: "1",
            role: "user",
            timestamp: Date.now(),
            blocks: [{ type: "text", text: "retained" }],
          },
        ],
        activeTools: [],
      },
    ),
  );

  const result = await evaluate(page, async () => {
    const c = (window as any).cache;
    let error = "";
    const put = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function (value, key) {
      if (value.id === "2") throw new DOMException("Quota exceeded", "QuotaExceededError");
      return put.call(this, value, key);
    };
    try {
      const noise = Array.from({ length: 80_000 }, () => crypto.randomUUID()).join("");
      await c.saveMainCache(
        { cacheScope: "quota", cacheExpiresAt: Date.now() + 60_000 },
        {
          id: "1",
          sessionId: "1",
          revision: 2,
          streamId: "a",
          messages: [
            {
              id: "2",
              role: "user",
              timestamp: Date.now(),
              blocks: [{ type: "text", text: noise }],
            },
          ],
          activeTools: [],
        },
      );
    } catch (failure) {
      error = String(failure);
    } finally {
      IDBObjectStore.prototype.put = put;
    }
    return { error, restored: await c.readMainCache() };
  });
  expect(result.error).toContain("Quota");
  expect(result.restored.session.messages[0].id).toBe("1");
  await context.close();
});

test.each(["Chromium", "WebKit"])(
  "%s cache survives suspension, closed connections, and a native read abort without unhandled rejections",
  async (engine) => {
    const context = await (engine === "WebKit" ? safari : browser).newContext();
    const page = await context.newPage();
    await page.goto(url);
    await page.waitForFunction(() => Boolean((window as any).cache));
    const result = await evaluate(page, async () => {
      const c = (window as any).cache;
      const unhandled: string[] = [];
      window.addEventListener("unhandledrejection", (event) => {
        unhandled.push(String(event.reason));
      });
      let opens = 0;
      let connection: IDBDatabase;
      const nativeOpen = IDBFactory.prototype.open;
      IDBFactory.prototype.open = function (...args) {
        opens += 1;
        const operation = nativeOpen.apply(this, args);
        operation.addEventListener("success", () => {
          connection = operation.result;
        });
        return operation;
      };
      const bootstrap = { cacheScope: "lifecycle", cacheExpiresAt: Date.now() + 60_000 };
      const session = {
        id: "1",
        sessionId: "1",
        streamId: "a",
        revision: 1,
        activeTools: [],
        messages: [{ id: "1", role: "user", timestamp: Date.now(), blocks: [] }],
      };
      await c.saveMainCache(bootstrap, session);
      const suspendedConnection = connection!;
      window.dispatchEvent(new PageTransitionEvent("pagehide", { persisted: true }));
      await Promise.resolve();
      window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true }));
      await c.saveMainCache(bootstrap, { ...session, revision: 2 });
      suspendedConnection.dispatchEvent(new Event("close"));
      const afterResume = await c.readMainCache();
      // A storage process termination closes the connection without pagehide.
      connection!.close();
      connection!.dispatchEvent(new Event("close"));
      await c.saveMainCache(bootstrap, { ...session, revision: 3 });
      const getAll = IDBObjectStore.prototype.getAll;
      IDBObjectStore.prototype.getAll = function (...args) {
        const operation = getAll.apply(this, args);
        this.transaction.abort();
        return operation;
      };
      let abort = "";
      try {
        await c.readMainCache();
      } catch (error) {
        abort = String(error);
      } finally {
        IDBObjectStore.prototype.getAll = getAll;
      }
      await new Promise((resolve) => setTimeout(resolve, 0));
      const retained = await c.readMainCache();
      // Suspend during the read half of a save, not just between finished saves.
      IDBObjectStore.prototype.getAll = function (...args) {
        const operation = getAll.apply(this, args);
        operation.addEventListener(
          "success",
          () => {
            window.dispatchEvent(new PageTransitionEvent("pagehide", { persisted: true }));
          },
          { once: true },
        );
        IDBObjectStore.prototype.getAll = getAll;
        return operation;
      };
      await c.saveMainCache(bootstrap, { ...session, revision: 4 });
      const afterOverlappingSuspension = await c.readMainCache();
      IDBFactory.prototype.open = nativeOpen;
      return { opens, afterResume, retained, afterOverlappingSuspension, abort, unhandled };
    });
    expect(result.opens).toBe(5);
    expect(result.afterOverlappingSuspension.session.revision).toBe(4);
    expect(result.afterResume.session.revision).toBe(2);
    expect(result.retained.session.revision).toBe(3);
    expect(result.abort).toMatch(/abort/i);
    expect(result.unhandled).toEqual([]);
    await context.setOffline(true);
    expect(await evaluate(page, () => (window as any).cache.readMainCache())).toMatchObject({
      session: { revision: 4 },
    });
    await context.setOffline(false);
    await page.reload();
    await page.waitForFunction(() => Boolean((window as any).cache));
    expect(await evaluate(page, () => (window as any).cache.readMainCache())).toMatchObject({
      session: { revision: 4 },
    });
    await context.close();
  },
);

test.each(["Chromium", "WebKit"])(
  "%s failed save joins the read abort and releases the poisoned connection",
  async (engine) => {
    const page = await fixture(engine === "WebKit" ? safari : browser);
    const result = await evaluate(page, async () => {
      const c = (window as any).cache;
      const bootstrap = { cacheScope: "failure", cacheExpiresAt: Date.now() + 60_000 };
      const session = {
        id: "1",
        sessionId: "1",
        streamId: "a",
        revision: 1,
        messages: [],
        activeTools: [],
      };
      await c.saveMainCache(bootstrap, session);
      let terminal = false;
      let premature = false;
      let opens = 0;
      const open = IDBFactory.prototype.open;
      IDBFactory.prototype.open = function (...args) {
        opens += 1;
        return open.apply(this, args);
      };
      const nativeTransaction = IDBDatabase.prototype.transaction;
      IDBDatabase.prototype.transaction = function (...args) {
        const transaction = nativeTransaction.apply(this, args);
        transaction.addEventListener("abort", () => {
          terminal = true;
        });
        return transaction;
      };
      const getAll = IDBObjectStore.prototype.getAll;
      IDBObjectStore.prototype.getAll = function (...args) {
        IDBObjectStore.prototype.getAll = getAll;
        const operation = getAll.apply(this, args);
        const transaction = this.transaction;
        // Model the native request failing before its transaction's abort task.
        queueMicrotask(() => {
          Object.defineProperty(operation, "error", {
            value: new DOMException(
              "Attempt to get a record from database without an in-progress transaction",
              "UnknownError",
            ),
          });
          operation.onerror!(new Event("error"));
          transaction.abort();
        });
        return operation;
      };
      const failed = c
        .saveMainCache(bootstrap, { ...session, revision: 2 })
        .catch((error: Error) => {
          premature = !terminal;
          return { name: error.name, message: error.message, stack: error.stack };
        });
      // Already queued saves must wait for the terminal event and use a new connection.
      const next = c.saveMainCache(bootstrap, { ...session, revision: 3 });
      const error = await failed;
      await next;
      const restored = await c.readMainCache();
      IDBFactory.prototype.open = open;
      IDBDatabase.prototype.transaction = nativeTransaction;
      return { premature, terminal, opens, error, revision: restored.session.revision };
    });
    expect(result.premature).toBe(false);
    expect(result.opens).toBe(1);
    expect(result.revision).toBe(3);
    expect(result.error.name).toBe("UnknownError");
    expect(result.error.stack).toContain("main-cache.ts");
    await page.close();
  },
);
