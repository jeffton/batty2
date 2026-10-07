import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { authorizeErrorReporting, reportBrowserError } from "./browser-errors";

afterEach(() => {
  authorizeErrorReporting(false);
  vi.restoreAllMocks();
});
describe("browser error reporting isolation", () => {
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
