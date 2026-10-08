import { expect, test } from "vite-plus/test";
import {
  isMemoryNoise,
  fitView,
  planNoiseCleanup,
  renderView,
  stripNoiseClauses,
  type MemoryLeaf,
} from "./memory";

const leaf = (kind: MemoryLeaf["kind"], text: string, source = 1): MemoryLeaf => ({
  kind,
  text,
  source,
  ordinal: 0,
  date: "2026-10-06T00:00:00.000Z",
});

test("only exact silent assistant and runtime-result notices are noise", () => {
  for (const text of ["NO_REPLY", " NO_REPLY\n"])
    expect(isMemoryNoise(leaf("talk", text))).toBe(true);
  expect(isMemoryNoise(leaf("note", "Runtime cron: [cron 123 result]\nNO_REPLY"))).toBe(true);
  expect(isMemoryNoise(leaf("note", "Runtime subagent: [subagent 123 result] NO_REPLY"))).toBe(
    true,
  );
  for (const kind of ["user", "tool", "echo", "note"] as const)
    expect(isMemoryNoise(leaf(kind, "NO_REPLY"))).toBe(false);
  for (const text of [
    "Use NO_REPLY for silence",
    "NO_REPLY: operation failed",
    "`NO_REPLY`",
    "NO_REPLY\nUseful result",
    "Runtime cron: [cron 123 result] NO_REPLY plus details",
  ]) {
    expect(isMemoryNoise(leaf("talk", text))).toBe(false);
    expect(isMemoryNoise(leaf("note", text))).toBe(false);
  }
});

test("cleanup reuses useful summaries and preserves all original leaves and IDs", () => {
  const leaves = new Map([
    [0, leaf("talk", "NO_REPLY")],
    [1, leaf("note", "Runtime cron: [cron 10 result]\nNO_REPLY")],
    [2, leaf("user", "Keep NO_REPLY discussions")],
    [3, leaf("talk", "Useful result")],
  ]);
  const before = JSON.stringify([...leaves]);
  const nodes = new Map([
    ["0+1", "talk: NO_REPLY"],
    ["1+1", "note: Runtime cron: [cron 10 result] NO_REPLY"],
    ["2+1", "user: Keep NO_REPLY discussions"],
    ["3+1", "talk: Useful result"],
    ["0+2", "note: both silent"],
    ["2+2", "user: Keep NO_REPLY discussions; talk: Useful result"],
    ["0+4", "talk: NO_REPLY; user: Keep NO_REPLY discussions"],
  ]);
  const plan = planNoiseCleanup(leaves, nodes);
  expect(plan.excluded).toEqual([0, 1]);
  expect(plan.updates.get("0+2")).toBe("");
  expect(plan.updates.get("0+4")).toBe(nodes.get("2+2"));
  expect(JSON.stringify([...leaves])).toBe(before);
  for (const [key, value] of plan.updates) nodes.set(key, value);
  expect(planNoiseCleanup(leaves, nodes).updates.size).toBe(0);
  expect(
    renderView(
      [
        { start: 0, count: 2 },
        { start: 2, count: 2 },
      ],
      nodes,
    ),
  ).toBe(`<chat>\n2+2|${nodes.get("2+2")}\n</chat>`);
});

test("an entirely silent history has a logarithmic cover rather than one part per leaf", () => {
  const nodes = new Map<string, string>();
  let parts: { start: number; count: number }[] = [];
  for (let id = 0; id < 16384; id++) {
    nodes.set(`${id}+1`, "");
    for (let count = 2; (id + 1) % count === 0; count *= 2)
      nodes.set(`${id + 1 - count}+${count}`, "");
    parts.push({ start: id, count: 1 });
    parts = fitView(parts, id + 1, nodes);
  }
  expect(parts).toEqual([{ start: 0, count: 16384 }]);
  expect(renderView(parts, nodes)).toBe("<chat>\n\n</chat>");
});

test("mixed summaries lose exact noise clauses, never meaningful discussions", () => {
  expect(
    stripNoiseClauses("talk: NO_REPLY; user: use NO_REPLY for silence; talk: Useful result"),
  ).toBe("user: use NO_REPLY for silence; talk: Useful result");
  expect(stripNoiseClauses("talk: 30×NO_REPLY; talk: NO_REPLY ×2; user: next task")).toBe(
    "user: next task",
  );
  expect(stripNoiseClauses("talk: NO_REPLY because nothing changed; user: NO_REPLY")).toBe(
    "talk: NO_REPLY because nothing changed; user: NO_REPLY",
  );
});
