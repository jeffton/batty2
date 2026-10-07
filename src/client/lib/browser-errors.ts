import type { App } from "vue";
import { withBaseUrl } from "./base-url";
import {
  browserFamily,
  platformFamily,
  safeErrorMessage,
  safeErrorName,
  safeErrorStack,
  type ErrorStage,
  type BrowserErrorReport,
} from "@/shared/browser-errors";

declare const __BATTY_BUILD_ID__: string;
let authenticated = false;
let recent: { key: string; time: number }[] = [];
export function authorizeErrorReporting(value: boolean): void {
  authenticated = value;
  if (!value) recent = [];
}

export function reportBrowserError(
  error: unknown,
  stage: ErrorStage,
  extra: { correlationId?: string; status?: number; hasFiles?: boolean } = {},
): void {
  try {
    if (!authenticated || !navigator.onLine) return;
    const message = safeErrorMessage(error instanceof Error ? error.message : "");
    const stack = safeErrorStack(error instanceof Error ? (error.stack ?? "") : "");
    const now = Date.now();
    recent = recent.filter((entry) => now - entry.time < 60_000);
    const errorName = safeErrorName(
      error instanceof Error || error instanceof DOMException ? error.name : "Unknown",
    );
    const key = JSON.stringify([stage, errorName, message, stack, extra.status, extra.hasFiles]);
    if (recent.length >= 10 || recent.some((entry) => entry.key === key)) return;
    recent.push({ key, time: now });
    const report: BrowserErrorReport = {
      timestamp: new Date(now).toISOString(),
      correlationId: extra.correlationId ?? crypto.randomUUID(),
      buildId: typeof __BATTY_BUILD_ID__ === "undefined" ? "dev" : __BATTY_BUILD_ID__,
      stage,
      browser: browserFamily(navigator.userAgent),
      platform: platformFamily(navigator.userAgent),
      errorName,
      message,
      stack,
      status: extra.status,
      hasFiles: extra.hasFiles,
    };
    // Separate transport: never feed telemetry failures back into telemetry or UI.
    void fetch(withBaseUrl("/api/browser-errors"), {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(report),
      signal: AbortSignal.timeout(5_000),
    }).catch(() => {});
  } catch {
    // Reporting must never replace the original failure or recurse.
  }
}

export function installBrowserErrorReporting(app: App): void {
  window.addEventListener("error", (event) =>
    reportBrowserError(event.error ?? new Error(event.message), "window"),
  );
  window.addEventListener("unhandledrejection", (event) =>
    reportBrowserError(event.reason, "unhandledrejection"),
  );
  app.config.errorHandler = (error) => {
    reportBrowserError(error, "vue");
    console.error(error);
  };
}
