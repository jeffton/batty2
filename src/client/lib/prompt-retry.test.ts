import { beforeEach, describe, expect, it } from "vite-plus/test";
import { clearPromptRetry, promptSubmissionId, retainPromptRetry } from "./prompt-retry";

beforeEach(() => localStorage.clear());
describe("uncertain prompt delivery", () => {
  it("reuses the original receipt key for a restored draft, including across remounts", () => {
    const original = promptSubmissionId("main", "prompt", "Run this once", []);
    retainPromptRetry("main", "prompt", "Run this once", [], original);
    expect(promptSubmissionId("main", "prompt", "Run this once", [])).toBe(original);
    // No component-local state is required to deduplicate a retry after reload.
    expect(promptSubmissionId("main", "prompt", "Run this once", [])).toBe(original);
    clearPromptRetry("main", original);
    expect(promptSubmissionId("main", "prompt", "Run this once", [])).not.toBe(original);
  });
  it("does not reuse a receipt key after changing text, attachments, or submission kind", () => {
    const file = new File(["before"], "input.txt", { lastModified: 1 });
    retainPromptRetry("main", "prompt", "Read this", [file], "original");
    expect(promptSubmissionId("main", "prompt", "Read this", [file])).toBe("original");
    expect(promptSubmissionId("main", "prompt", "Read that", [file])).not.toBe("original");
    expect(promptSubmissionId("main", "steer", "Read this", [file])).not.toBe("original");
    expect(
      promptSubmissionId("main", "prompt", "Read this", [
        new File(["after"], "input.txt", { lastModified: 2 }),
      ]),
    ).not.toBe("original");
  });
  it("abandons the old receipt when a changed draft is submitted", () => {
    retainPromptRetry("main", "prompt", "Original", [], "uncertain-original");
    const changed = promptSubmissionId("main", "prompt", "Changed", []);
    clearPromptRetry("main", changed);
    expect(promptSubmissionId("main", "prompt", "Original", [])).not.toBe("uncertain-original");
  });
  it("does not clear another draft's receipt after an older request finishes", () => {
    retainPromptRetry("main", "prompt", "Newer draft", [], "newer");
    clearPromptRetry("main", "older");
    expect(promptSubmissionId("main", "prompt", "Newer draft", [])).toBe("newer");
  });
});
