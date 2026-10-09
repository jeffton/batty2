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
for (const { width, colorScheme } of [
  { width: 390, colorScheme: "light" as const },
  { width: 1100, colorScheme: "dark" as const },
]) {
  test(`cron, subagent and ordinary reply artifacts render directly at ${width}px (${colorScheme})`, async () => {
    const page = await browser.newPage({ viewport: { width, height: 900 }, colorScheme });
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
        const codeBackground = await message
          .locator(".markdown-body code")
          .evaluate((element) => getComputedStyle(element).backgroundColor);
        const actions = message.locator(".message__diff-button, .message__notice-btn");
        for (const action of await actions.all()) {
          const styles = await action.evaluate((element) => {
            const style = getComputedStyle(element);
            return { background: style.backgroundColor, color: style.color };
          });
          expect(styles.background).toBe(codeBackground);
          expect(styles.color).toBe(
            await diff.evaluate((element) => getComputedStyle(element).color),
          );
          const actionBox = (await action.boundingBox())!;
          expect(actionBox.width).toBeGreaterThanOrEqual(44);
          expect(actionBox.height).toBeGreaterThanOrEqual(44);
          await page.keyboard.press("Tab");
          await action.focus();
          expect(await action.evaluate((element) => getComputedStyle(element).outlineStyle)).toBe(
            "solid",
          );
          await action.hover();
          expect(
            await action.evaluate((element) => getComputedStyle(element).backgroundColor),
          ).not.toBe(codeBackground);
          await page.mouse.move(0, 0);
        }
        const box = (await diff.boundingBox())!;
        expect(box.width).toBeGreaterThanOrEqual(44);
        expect(box.height).toBeGreaterThanOrEqual(44);
        await diff.click();
        const popover = page.locator(".agent-turn-diff-popover:popover-open");
        await popover.waitFor();
        await popover.getByRole("button", { name: "Close code changes" }).click();
      }
      expect(await page.getByRole("button", { name: "Open cron session" }).count()).toBe(1);
      expect(await page.getByRole("button", { name: "Open subagent session" }).count()).toBe(1);
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
      ).toBe(true);
      expect(errors).toEqual([]);
      await page.screenshot({
        path: `/tmp/batty2-notice-artifacts-${width}-${colorScheme}.png`,
        fullPage: true,
      });
    } finally {
      await page.close();
    }
  }, 30_000);

  test(`runtime notice popovers isolate styles and preserve nested navigation (${colorScheme})`, async () => {
    const page = await browser.newPage({ viewport: { width, height: 900 }, colorScheme });
    page.setDefaultTimeout(5000);
    await page.route("**/api/sessions/42", (route) =>
      route.fulfill({
        json: {
          id: "42",
          sessionId: "42",
          messages: [
            {
              id: "worker-reply",
              role: "assistant",
              timestamp: 1,
              turnPhase: "final",
              blocks: [{ type: "text", text: "Worker `inline code`" }],
            },
            {
              id: "nested-notice",
              role: "custom",
              timestamp: 2,
              customType: "batty-runtime-notice:subagent",
              text: "Nested worker",
              data: { subagent: { sessionId: "43" } },
            },
          ],
          activeTools: [],
          isStreaming: false,
        },
      }),
    );
    await page.route("**/api/sessions/43", (route) =>
      route.fulfill({
        json: { id: "43", sessionId: "43", messages: [], activeTools: [], isStreaming: false },
      }),
    );
    try {
      await page.goto(url);
      const normalCode = page.locator(".message--assistant .markdown-body code").first();
      const normalBackground = await normalCode.evaluate(
        (element) => getComputedStyle(element).backgroundColor,
      );
      const noticeBackground = await page
        .locator(".message__runtime-markdown code")
        .first()
        .evaluate((element) => getComputedStyle(element).backgroundColor);
      expect(noticeBackground).not.toBe(normalBackground);
      await page.getByRole("button", { name: "Open subagent session", exact: true }).click();
      const parent = page.locator("#subagent-notice-popover-42");
      await parent.getByText("Worker inline code", { exact: true }).waitFor();
      expect(
        await parent
          .locator(".markdown-body code")
          .evaluate((element) => getComputedStyle(element).backgroundColor),
      ).toBe(normalBackground);
      expect(await parent.evaluate((element) => element.parentElement === document.body)).toBe(
        true,
      );
      await parent.getByRole("button", { name: "Open subagent session", exact: true }).click();
      const child = page.locator("#subagent-notice-popover-43");
      await child.locator(".transcript").waitFor();
      expect(await parent.evaluate((element) => element.matches(":popover-open"))).toBe(true);
      expect(await child.evaluate((element) => element.matches(":popover-open"))).toBe(true);
      await child.getByRole("button", { name: "Close subagent transcript" }).click();
      expect(await parent.evaluate((element) => element.matches(":popover-open"))).toBe(true);
      await parent.getByRole("button", { name: "Close subagent transcript" }).click();
    } finally {
      await page.close();
    }
  }, 30_000);
}
