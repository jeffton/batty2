// @vitest-environment node
import path from "node:path";
import vue from "@vitejs/plugin-vue";
import { chromium, type Browser, type Page } from "patchright";
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
  url = `${server.resolvedUrls!.local[0]}src/client/components/SessionTranscript.fixture.html`;
  browser = await chromium.launch({ headless: true });
}, 30_000);
afterAll(async () => {
  await browser?.close();
  await server?.close();
});
async function state(page: Page, value: string) {
  await page.evaluate(
    (detail) => document.dispatchEvent(new CustomEvent("fixture-state", { detail })),
    value,
  );
}

for (const width of [390, 1100]) {
  test(`runtime completion collapses automatic details but preserves manual expansion at ${width}px`, async () => {
    const page = await browser.newPage({ viewport: { width, height: 800 } });
    page.setDefaultTimeout(5_000);
    try {
      await page.goto(url);
      const details = page.getByText("Header spacing task details", { exact: true });
      await details.waitFor();
      expect(await page.locator(".details-button").count()).toBe(0);
      await state(page, "reply");
      await details.waitFor({ state: "hidden" });
      const toggle = page.getByRole("button", { name: "Show details", exact: true });
      await toggle.waitFor();
      expect(await toggle.locator(".lucide-chevron-up").count()).toBe(1);
      const controls = page.locator(".reply-actions button");
      expect(await controls.nth(0).getAttribute("aria-label")).toBe("Copy reply as markdown");
      for (const control of await controls.all())
        expect(await control.boundingBox()).toMatchObject({ width: 44, height: 44 });
      await toggle.click();
      await details.waitFor();
      expect(await page.locator(".lucide-chevron-down").count()).toBe(1);
      await state(page, "delivery");
      await page.getByText("Spacing worker completed", { exact: true }).waitFor();
      await details.waitFor();
      await state(page, "finished");
      await page.getByText("Spacing live", { exact: true }).waitFor();
      await page
        .getByText("Spacing worker completed", { exact: true })
        .waitFor({ state: "hidden" });
      await details.waitFor();
      await page.getByRole("button", { name: "Collapse details", exact: true }).click();
      await details.waitFor({ state: "hidden" });
      await page.getByRole("button", { name: "Show details", exact: true }).first().click();
      await details.waitFor();
      await state(page, "switch");
      await details.waitFor({ state: "hidden" });
      expect(
        await page.getByRole("button", { name: "Collapse details", exact: true }).count(),
      ).toBe(0);
      await state(page, "always");
      await details.waitFor();
      expect(await page.locator(".details-button").count()).toBe(0);
    } finally {
      await page.close();
    }
  });
}
