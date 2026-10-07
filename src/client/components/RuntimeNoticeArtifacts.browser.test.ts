// @vitest-environment node
import path from "node:path";
import vue from "@vitejs/plugin-vue";
import { chromium, type Browser } from "patchright";
import { createServer, type ViteDevServer } from "vite";
import { afterAll, beforeAll, expect, test } from "vite-plus/test";
let server: ViteDevServer;
let browser: Browser;
let url: string;
beforeAll(async () => {
  server = await createServer({
    configFile: false,
    plugins: [vue()],
    resolve: { alias: { "@": path.resolve("src") } },
    server: { host: "127.0.0.1", port: 0 },
  });
  await server.listen();
  url = `${server.resolvedUrls!.local[0]}src/client/components/RuntimeNoticeArtifacts.fixture.html`;
  browser = await chromium.launch({ headless: true });
}, 30_000);
afterAll(async () => {
  await browser?.close();
  await server?.close();
});
for (const width of [390, 1100]) {
  test(`cron, subagent and ordinary reply artifacts render directly at ${width}px`, async () => {
    const page = await browser.newPage({ viewport: { width, height: 900 } });
    page.setDefaultTimeout(5000);
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    try {
      await page.goto(url);
      await page.getByText("Cabin attached.").first().waitFor();
      const messages = page.locator("article.message");
      expect(await messages.count()).toBe(3);
      for (const message of await messages.all()) {
        expect(await message.getByText("Cabin.jpg", { exact: true }).count()).toBe(1);
        expect(await message.locator(".shared-sites__meta strong").count()).toBe(1);
        const diff = message.getByRole("button", { name: "View changes" });
        const box = (await diff.boundingBox())!;
        expect(box.width).toBeGreaterThanOrEqual(44);
        expect(box.height).toBeGreaterThanOrEqual(44);
        await diff.click();
        const popover = page.locator(".agent-turn-diff-popover:popover-open");
        await popover.waitFor();
        await popover.getByRole("button", { name: "Close code changes" }).click();
      }
      expect(await page.getByText("Open cron session").count()).toBe(0);
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
      ).toBe(true);
      expect(errors).toEqual([]);
      await page.screenshot({ path: `/tmp/batty2-notice-artifacts-${width}.png`, fullPage: true });
    } finally {
      await page.close();
    }
  }, 30_000);
}
