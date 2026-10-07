import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { submitMainPrompt } from "./api";

afterEach(() => vi.restoreAllMocks());

describe("multipart prompt uploads", () => {
  it.each([
    ["prompt", "With a photo"],
    ["prompt", ""],
    ["steer", "Change this"],
  ] as const)("detaches iOS files for %s with text %j", async (kind, text) => {
    vi.spyOn(navigator, "userAgent", "get").mockReturnValue(
      "Mozilla/5.0 (iPhone) AppleWebKit/605.1.15 Version/27.0 Mobile Safari/604.1",
    );
    const file = new File([new Uint8Array([1, 2, 3, 255])], "photo.png", {
      type: "image/png",
      lastModified: 123,
    });
    const read = vi.spyOn(file, "arrayBuffer");
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
      const body = init!.body as FormData;
      const upload = body.get("files") as File;
      // The disk-backed object must not reach fetch, where WebKit loses it.
      expect(upload).not.toBe(file);
      expect(read).toHaveBeenCalledOnce();
      expect(Array.from(new Uint8Array(await upload.arrayBuffer()))).toEqual([1, 2, 3, 255]);
      expect(upload.name).toBe(file.name);
      expect(upload.type).toBe(file.type);
      expect(upload.lastModified).toBe(file.lastModified);
      expect(body.get("text")).toBe(text);
      expect(body.get("clientMessageId")).toBe("receipt");
      expect(new Headers(init!.headers).has("Content-Type")).toBe(false);
      expect(new Headers(init!.headers).get("X-Batty-Correlation-ID")).toMatch(/^[a-f0-9-]{36}$/);
      return Response.json({ disposition: "queued", submissionId: "42", sessionId: "1" });
    });
    expect(await submitMainPrompt(kind, text, [file], "receipt")).toEqual({
      disposition: "queued",
      submissionId: "42",
      sessionId: "1",
    });
  });

  it("does not issue a request if a selected file cannot be read", async () => {
    vi.spyOn(navigator, "userAgent", "get").mockReturnValue("AppleWebKit/605.1.15 Safari/604.1");
    const file = new File(["photo"], "photo.png", { type: "image/png" });
    vi.spyOn(file, "arrayBuffer").mockRejectedValue(new Error("File unavailable"));
    const fetch = vi.spyOn(globalThis, "fetch");
    await expect(submitMainPrompt("prompt", "Retry me", [file], "receipt")).rejects.toThrow(
      "File unavailable",
    );
    expect(fetch).not.toHaveBeenCalled();
  });

  it("does not copy files for Chromium or text-only uploads", async () => {
    vi.spyOn(navigator, "userAgent", "get").mockReturnValue("AppleWebKit/537.36 Chrome/144.0");
    const file = new File(["photo"], "photo.png", { type: "image/png" });
    const read = vi.spyOn(file, "arrayBuffer");
    const fetch = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async () =>
        Response.json({ disposition: "started", submissionId: "42", sessionId: "1" }),
      );
    await submitMainPrompt("prompt", "photo", [file], "receipt");
    expect(((fetch.mock.calls[0]![1]!.body as FormData).get("files") as File).name).toBe(file.name);
    expect(read).not.toHaveBeenCalled();
    await submitMainPrompt("prompt", "text only", [], "other");
    expect((fetch.mock.calls[1]![1]!.body as FormData).getAll("files")).toEqual([]);
  });
});
