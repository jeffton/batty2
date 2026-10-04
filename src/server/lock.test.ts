import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vite-plus/test";
import { acquireLock } from "./lock";

test("concurrent starters acquire exactly one lifetime lock and release allows takeover", async () => {
  const directory = await mkdtemp(join(tmpdir(), "batty2-lock-"));
  const lock = join(directory, "runtime.lock");
  let release: (() => Promise<void>) | undefined;
  try {
    const results = await Promise.allSettled(Array.from({ length: 8 }, () => acquireLock(lock)));
    const winners = results.filter(
      (result): result is PromiseFulfilledResult<() => Promise<void>> =>
        result.status === "fulfilled",
    );
    expect(winners).toHaveLength(1);
    release = winners[0]!.value;
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(7);
    await release();
    release = await acquireLock(lock);
  } finally {
    await release?.();
    await rm(directory, { recursive: true, force: true });
  }
});
