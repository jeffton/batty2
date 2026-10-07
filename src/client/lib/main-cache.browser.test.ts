// @vitest-environment node
import path from "node:path";
import { chromium, type Browser, type Page } from "patchright";
import { createServer, type ViteDevServer } from "vite";
import { afterAll, beforeAll, expect, test } from "vite-plus/test";

let browser: Browser;
let server: ViteDevServer;
let url: string;
// Patchright isolates evaluations by default; this fixture exposes its API in the main world.
const evaluate = <T>(page: Page, fn: () => T) => page.evaluate(fn, undefined, undefined, false);
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
}, 30_000);
afterAll(async () => {
  await browser?.close();
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
