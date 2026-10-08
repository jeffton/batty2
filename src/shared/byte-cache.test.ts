import { expect, test } from "vite-plus/test";
import { ByteCache } from "./byte-cache";

test("byte LRU evicts cold entries, bypasses oversized originals and supports invalidation", () => {
  const cache = new ByteCache<string>(300, (value) => value.length);
  cache.set("a", "x".repeat(50));
  cache.set("b", "x".repeat(50));
  expect(cache.get("a")).toBeDefined();
  cache.set("c", "x".repeat(50));
  expect(cache.get("b")).toBeUndefined();
  expect(cache.get("a")).toBeDefined();
  cache.set("a", "x".repeat(1000));
  expect(cache.get("a")).toBeUndefined();
  expect(cache.bytes).toBeLessThanOrEqual(300);
  cache.delete("c");
  expect(cache.bytes).toBe(0);
});
