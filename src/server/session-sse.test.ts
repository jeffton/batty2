// @vitest-environment node
import { EventEmitter } from "node:events";
import type { ServerResponse } from "node:http";
import { expect, test, vi } from "vite-plus/test";
import { streamSession, writeStreamEvent } from "./session-sse";
import type { Runtime } from "./runtime";
import type { TranscriptImages } from "./transcript-images";

test("SSE catch-up waits for socket drain before reading the next page and cancels on disconnect", async () => {
  const socket = new EventEmitter() as EventEmitter & {
    write: ReturnType<typeof vi.fn>;
    destroyed: boolean;
    writableEnded: boolean;
    writableNeedDrain: boolean;
  };
  socket.write = vi.fn(() => false);
  socket.destroyed = false;
  socket.writableEnded = false;
  socket.writableNeedDrain = true;
  const unsubscribe = vi.fn();
  const state = vi.fn(async (_id: string, _view: undefined, _history: boolean, after: string) => ({
    historyAfter: after,
    historyCursor: String(Number(after ?? 0) + 120),
    hasMoreRecentMessages: true,
    messages: [],
    revision: 1,
  }));
  const runtime = {
    streamId: "test",
    state,
    harness: { subscribeCommits: () => unsubscribe },
    memory: { status: () => ({ pending: 0 }) },
  } as unknown as Runtime;
  const images = { state: async (value: unknown) => value } as TranscriptImages;
  const close = streamSession(
    socket as unknown as ServerResponse,
    runtime,
    1 as never,
    images,
    "0",
    vi.fn(),
  );
  await new Promise((resolve) => setImmediate(resolve));
  expect(state).toHaveBeenCalledTimes(1);
  expect(socket.write).toHaveBeenCalledTimes(1);
  socket.emit("drain");
  await new Promise((resolve) => setImmediate(resolve));
  expect(state).toHaveBeenCalledTimes(2);
  expect(state.mock.calls[1]![3]).toBe("120");
  socket.destroyed = true;
  socket.emit("close");
  await new Promise((resolve) => setImmediate(resolve));
  expect(state).toHaveBeenCalledTimes(2);
  expect(unsubscribe).toHaveBeenCalledOnce();
  expect(socket.listenerCount("drain")).toBe(0);
  close();
});

test("drain and close listeners are released after successful backpressure wait", async () => {
  const socket = new EventEmitter() as EventEmitter & {
    write: () => boolean;
    destroyed: boolean;
    writableEnded: boolean;
  };
  socket.write = () => false;
  socket.destroyed = false;
  socket.writableEnded = false;
  let completed = false;
  const write = writeStreamEvent(socket as unknown as ServerResponse, "event").then(() => {
    completed = true;
  });
  await Promise.resolve();
  expect(completed).toBe(false);
  socket.emit("drain");
  await write;
  expect(completed).toBe(true);
  expect(socket.listenerCount("drain")).toBe(0);
  expect(socket.listenerCount("close")).toBe(0);
});
