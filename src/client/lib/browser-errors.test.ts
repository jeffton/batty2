import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { authorizeErrorReporting, reportBrowserError } from "./browser-errors";

afterEach(() => {
  authorizeErrorReporting(false);
  vi.restoreAllMocks();
});
describe("browser error reporting isolation", () => {
  it("reports native cache diagnostics and asset stack without arbitrary error text", () => {
    const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response());
    authorizeErrorReporting(true);
    vi.spyOn(navigator, "onLine", "get").mockReturnValue(true);
    const error = new Error(
      "Attempt to get a record from database without an in-progress transaction",
    );
    error.name = "UnknownError";
    error.stack =
      "UnknownError: private text\nrequest@https://example.test/assets/index-test.js:20:30";
    reportBrowserError(error, "cache-write");
    const report = JSON.parse(fetch.mock.calls[0]![1]!.body as string);
    expect(report).toMatchObject({
      stage: "cache-write",
      errorName: "UnknownError",
      message: error.message,
      stack: "/assets/index-test.js:20:30",
    });
    expect(JSON.stringify(report)).not.toContain("private text");
  });
  it("drops offline/unauthenticated reports, deduplicates, and contains transport errors", () => {
    const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(() => {
      throw new Error("Telemetry unavailable");
    });
    reportBrowserError(new Error("Load failed"), "window");
    expect(fetch).not.toHaveBeenCalled();
    authorizeErrorReporting(true);
    vi.spyOn(navigator, "onLine", "get").mockReturnValue(false);
    reportBrowserError(new Error("Load failed"), "window");
    expect(fetch).not.toHaveBeenCalled();
    vi.spyOn(navigator, "onLine", "get").mockReturnValue(true);
    expect(() => reportBrowserError(new Error("Load failed"), "window")).not.toThrow();
    reportBrowserError(new Error("Load failed"), "window");
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
