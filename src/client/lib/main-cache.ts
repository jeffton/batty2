import type { BootstrapPayload, SessionState, UiMessage } from "@/shared/types";

export const CACHE_DAY_MS = 86_400_000;
export const CACHE_BYTE_BUDGET = 32 * 1024 * 1024;
export const CACHE_HARD_LIMIT = 128 * 1024 * 1024;
const DB_NAME = "batty-main-reading-v1";
export const CACHE_EPOCH_KEY = "batty:main-cache-epoch";
export const REVOKED_CACHE_SCOPE_KEY = "batty:revoked-cache-scope";
let admittedEpoch = localStorage.getItem(CACHE_EPOCH_KEY);
export function registerMainCacheBootstrap(): void {
  admittedEpoch = localStorage.getItem(CACHE_EPOCH_KEY);
}
function isCacheAuthorized(): boolean {
  return admittedEpoch === localStorage.getItem(CACHE_EPOCH_KEY);
}
interface MessageRecord {
  id: string;
  timestamp: number;
  json: string;
  bytes: number;
}
interface CacheMetadata {
  epoch: string | null;
  bootstrap: BootstrapPayload;
  session: SessionState;
  savedAt: number;
}
let database: Promise<IDBDatabase> | undefined;
let queue = Promise.resolve();
let generation = 0;
const serialized = new WeakMap<UiMessage, MessageRecord>();

function request<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}
function transactionDone(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onabort = () => reject(transaction.error ?? new Error("Cache transaction aborted"));
    transaction.onerror = () => reject(transaction.error);
  });
}
function open(): Promise<IDBDatabase> {
  database ??= new Promise((resolve, reject) => {
    const operation = indexedDB.open(DB_NAME, 1);
    operation.onupgradeneeded = () => {
      operation.result.createObjectStore("metadata");
      operation.result.createObjectStore("messages", { keyPath: "id" });
    };
    operation.onsuccess = () => resolve(operation.result);
    operation.onerror = () => {
      database = undefined;
      reject(operation.error);
    };
  });
  return database;
}

export function retainCacheRecords(records: MessageRecord[], now: number): MessageRecord[] {
  const sorted = [...records].sort(
    (a, b) =>
      Number(a.id.split(":")[0]) - Number(b.id.split(":")[0]) ||
      Number(a.id.split(":")[1] ?? 0) - Number(b.id.split(":")[1] ?? 0),
  );
  let bytes = sorted.reduce((total, row) => total + row.bytes, 0);
  while (sorted.length > 1) {
    const oldest = sorted[0]!;
    const optional = oldest.timestamp < now - CACHE_DAY_MS;
    if (
      bytes <= CACHE_HARD_LIMIT &&
      (!optional || (bytes <= CACHE_BYTE_BUDGET && oldest.timestamp >= now - 7 * CACHE_DAY_MS))
    )
      break;
    const entryId = oldest.id.split(":")[0];
    const entry = sorted.filter((row) => row.id.split(":")[0] === entryId);
    if (entry.some((row) => row.timestamp >= now - CACHE_DAY_MS)) break;
    for (let index = 0; index < entry.length; index += 1) bytes -= sorted.shift()!.bytes;
  }
  if (bytes > CACHE_HARD_LIMIT)
    throw new Error("The latest day exceeds the 128 MiB reading-cache limit");
  return sorted;
}

export function authorizePreviewCache(bootstrap: BootstrapPayload): void {
  if (
    !isCacheAuthorized() ||
    bootstrap.cacheScope === localStorage.getItem(REVOKED_CACHE_SCOPE_KEY)
  )
    return;
  navigator.serviceWorker?.controller?.postMessage({
    type: "authorize-private-previews",
    scope: bootstrap.cacheScope,
    expiresAt: bootstrap.cacheExpiresAt,
    cacheEpoch: admittedEpoch,
  });
}

export async function readMainCache(): Promise<CacheMetadata | undefined> {
  const db = await open();
  const transaction = db.transaction(["metadata", "messages"], "readonly");
  const done = transactionDone(transaction);
  const [metadata, records] = await Promise.all([
    request(transaction.objectStore("metadata").get("current")) as Promise<
      CacheMetadata | undefined
    >,
    request(transaction.objectStore("messages").getAll()) as Promise<MessageRecord[]>,
  ]);
  await done;
  if (!metadata) return undefined;
  if (metadata.bootstrap.cacheScope === localStorage.getItem(REVOKED_CACHE_SCOPE_KEY)) {
    await clearMainCache();
    return undefined;
  }
  if (
    metadata.epoch !== localStorage.getItem(CACHE_EPOCH_KEY) ||
    !metadata.bootstrap.cacheExpiresAt ||
    metadata.bootstrap.cacheExpiresAt <= Date.now()
  ) {
    await clearMainCache();
    return undefined;
  }
  authorizePreviewCache(metadata.bootstrap);
  const messages = retainCacheRecords(records, Date.now()).map(
    (record) => JSON.parse(record.json) as UiMessage,
  );
  return {
    ...metadata,
    session: {
      ...metadata.session,
      messages,
      hasMoreMessages: metadata.session.totalMessageCount > messages.length,
    },
  };
}

export function saveMainCache(bootstrap: BootstrapPayload, session: SessionState): Promise<void> {
  if (
    !isCacheAuthorized() ||
    bootstrap.cacheScope === localStorage.getItem(REVOKED_CACHE_SCOPE_KEY) ||
    !bootstrap.cacheScope ||
    session.isSubagentSession ||
    session.isCronSession
  )
    return Promise.resolve();
  authorizePreviewCache(bootstrap);
  const admitted = generation;
  const operation = queue.then(() =>
    navigator.locks.request("batty-main-reading-cache", async () => {
      if (admitted !== generation || !isCacheAuthorized()) return;
      const db = await open();
      const read = db.transaction(["metadata", "messages"], "readonly");
      const readDone = transactionDone(read);
      const [oldMetadata, oldRows] = await Promise.all([
        request(read.objectStore("metadata").get("current")) as Promise<CacheMetadata | undefined>,
        request(read.objectStore("messages").getAll()) as Promise<MessageRecord[]>,
      ]);
      await readDone;
      if (admitted !== generation || !isCacheAuthorized()) return;
      const sameScope =
        oldMetadata?.bootstrap.cacheScope === bootstrap.cacheScope &&
        oldMetadata?.session.id === session.id;
      if (
        sameScope &&
        oldMetadata?.session.streamId === session.streamId &&
        (oldMetadata.session.revision ?? 0) > (session.revision ?? 0)
      )
        return;
      const oldById = new Map((sameScope ? oldRows : []).map((record) => [record.id, record]));
      const rows = session.messages.map((message) => {
        let row = serialized.get(message);
        if (!row) {
          const json = JSON.stringify(message);
          row = {
            id: message.id,
            timestamp: message.timestamp,
            json,
            bytes: new TextEncoder().encode(json).byteLength,
          };
          serialized.set(message, row);
        }
        return row;
      });
      const kept = retainCacheRecords(rows, Date.now());
      const transaction = db.transaction(["metadata", "messages"], "readwrite");
      const done = transactionDone(transaction);
      const messages = transaction.objectStore("messages");
      try {
        if (!sameScope) messages.clear();
        const retainedIds = new Set(kept.map((row) => row.id));
        for (const old of oldById.values()) if (!retainedIds.has(old.id)) messages.delete(old.id);
        for (const row of kept) if (oldById.get(row.id)?.json !== row.json) messages.put(row);
        // Pinia exposes nested Vue proxies; persist a plain JSON snapshot rather than cloning them.
        const metadata: CacheMetadata = {
          epoch: admittedEpoch,
          bootstrap,
          session: { ...session, messages: [] },
          savedAt: Date.now(),
        };
        const metadataJson = JSON.stringify(metadata);
        const totalBytes =
          kept.reduce((total, row) => total + row.bytes, 0) +
          new TextEncoder().encode(metadataJson).byteLength;
        if (totalBytes > CACHE_HARD_LIMIT)
          throw new Error("Reading cache exceeds the 128 MiB limit");
        transaction.objectStore("metadata").put(JSON.parse(metadataJson), "current");
      } catch (error) {
        transaction.abort();
        await done.catch(() => {});
        throw error;
      }
      await done;
    }),
  );
  queue = operation.catch(() => {});
  return operation;
}

export async function clearMainCache(cacheEpoch: string = crypto.randomUUID()): Promise<string> {
  localStorage.setItem(CACHE_EPOCH_KEY, cacheEpoch);
  generation += 1;
  await queue;
  await navigator.locks.request("batty-main-reading-cache", async () => {
    const db = await open();
    const transaction = db.transaction(["metadata", "messages"], "readwrite");
    const done = transactionDone(transaction);
    transaction.objectStore("metadata").clear();
    transaction.objectStore("messages").clear();
    await done;
  });
  const worker = navigator.serviceWorker?.controller;
  if (worker)
    await new Promise<void>((resolve, reject) => {
      const channel = new MessageChannel();
      const timer = setTimeout(() => {
        channel.port1.close();
        reject(new Error("Private preview cache clearing timed out"));
      }, 20_000);
      channel.port1.onmessage = (event) => {
        clearTimeout(timer);
        channel.port1.close();
        if (event.data.error) reject(new Error(event.data.error));
        else resolve();
      };
      worker.postMessage({ type: "clear-private-previews", cacheEpoch }, [channel.port2]);
    });
  return cacheEpoch;
}
