// @vitest-environment node
import path from "node:path";
import vue from "@vitejs/plugin-vue";
import { chromium, type Browser, type Page } from "patchright";
import { createServer, type ViteDevServer } from "vite";
import { afterAll, beforeAll, expect, test } from "vite-plus/test";

declare global {
  interface Window {
    __layoutReads: number;
  }
}

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
  test(`image-heavy transcript stays bounded and idle streaming does not poll layout at ${width}px`, async () => {
    const page = await browser.newPage({ viewport: { width, height: 800 } });
    try {
      await page.goto(url);
      await state(page, "long");
      await page.getByText("Long message 1999", { exact: true }).waitFor();
      await page.waitForTimeout(300);
      expect(await page.locator(".message").count()).toBeLessThan(30);
      expect(await page.locator(".transcript__tail .message").count()).toBe(8);
      const image = page.locator(".transcript__tail img").last();
      expect(await image.getAttribute("loading")).toBe("lazy");
      expect(await image.getAttribute("decoding")).toBe("async");
      expect(await image.getAttribute("fetchpriority")).toBe("low");
      expect(await image.locator("..").getAttribute("aria-label")).toBe(
        "Open original: Image 1999",
      );
      expect((await image.boundingBox())!.width).toBeLessThanOrEqual(Math.min(width, 512));
      await page.evaluate(() => {
        const original = Element.prototype.getBoundingClientRect;
        window.__layoutReads = 0;
        Element.prototype.getBoundingClientRect = function () {
          if (
            this.classList.contains("transcript") ||
            this.classList.contains("transcript__bottom")
          )
            window.__layoutReads++;
          return original.call(this);
        };
      });
      await page.waitForTimeout(300);
      expect(await page.evaluate(() => window.__layoutReads)).toBe(0);
      const transcript = page.locator(".transcript");
      await transcript.hover();
      await page.mouse.wheel(0, -1200);
      await page.waitForTimeout(150);
      const anchor = await page.locator(".message__text").evaluateAll((elements) => {
        const visible = elements.find((element) => {
          const rect = element.getBoundingClientRect();
          return rect.top >= 0 && rect.top < 650;
        })!;
        return { text: visible.textContent!, top: visible.getBoundingClientRect().top };
      });
      await state(page, "append");
      await page.waitForTimeout(150);
      const after = await page.getByText(anchor.text, { exact: true }).boundingBox();
      expect(Math.abs(after!.y - anchor.top)).toBeLessThan(20);
      await page.getByRole("button", { name: "Jump to latest" }).click();
      await page.getByText("Fix spacing", { exact: true }).waitFor();
      await page.waitForTimeout(300);
      expect(
        await transcript.evaluate(
          (element) => element.scrollHeight - element.scrollTop - element.clientHeight,
        ),
      ).toBeLessThan(14);
    } finally {
      await page.close();
    }
  });
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
