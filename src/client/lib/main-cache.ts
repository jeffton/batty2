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
const owners = new WeakMap<IDBDatabase, Promise<IDBDatabase>>();
let queue = Promise.resolve();
let generation = 0;
const serialized = new WeakMap<UiMessage, MessageRecord>();

function request<T>(request: IDBRequest<T>): Promise<T> {
  // Native DOMExceptions on iOS have no JS stack. Capture the issuing site,
  // retaining the native name/message for the UI and allowlisted telemetry.
  const failure = new Error();
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => {
      failure.name = request.error!.name;
      failure.message = request.error!.message;
      reject(failure);
    };
  });
}

async function readRecords(db: IDBDatabase) {
  const transaction = db.transaction(["metadata", "messages"], "readonly");
  const done = transactionDone(transaction, "read");
  const results = await Promise.allSettled([
    request(transaction.objectStore("metadata").get("current")) as Promise<
      CacheMetadata | undefined
    >,
    request(transaction.objectStore("messages").getAll()) as Promise<MessageRecord[]>,
    done,
  ]);
  // A request error arrives before the transaction's terminal abort event.
  // Join that event before releasing the save lock or reusing the connection.
  const failures = results.filter((result) => result.status === "rejected");
  // Requests cancelled by the abort are secondary to the native failure that caused it.
  const failure = failures.find((result) => result.reason?.name !== "AbortError") ?? failures[0];
  if (failure) throw failure.reason;
  return [
    (results[0] as PromiseFulfilledResult<CacheMetadata | undefined>).value,
    (results[1] as PromiseFulfilledResult<MessageRecord[]>).value,
  ] as const;
}
function transactionDone(
  transaction: IDBTransaction,
  phase: "read" | "write" | "clear",
): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    // Request errors bubble before abort. Settle on the terminal event so callers
    // cannot start the next cache operation while this transaction is still alive.
    transaction.onabort = () => {
      const db = transaction.db;
      if (database === owners.get(db)) database = undefined;
      db.close();
      reject(transaction.error ?? new Error(`Cache transaction aborted: ${phase}`));
    };
  });
}
function releaseConnection(): void {
  const pending = database;
  database = undefined;
  // close() lets already-issued transactions complete but releases the connection
  // before suspension. A restored page opens a new connection.
  void pending?.then(
    (db) => db.close(),
    () => {},
  );
}
window.addEventListener("pagehide", releaseConnection);
// Switching iOS apps can suspend the storage process without pagehide. Drop the
// connection on both transitions: foreground is also a boundary when WebKit
// delivered no background event before suspension. In-flight requests still
// settle normally, and their errors remain visible to callers.
document.addEventListener("visibilitychange", releaseConnection);
async function open(): Promise<IDBDatabase> {
  for (;;) {
    const pending = openConnection();
    const db = await pending;
    // Visibility can revoke an open that has not delivered its success event
    // yet. Never hand that closing connection to a new transaction.
    if (database === pending) return db;
  }
}
function openConnection(): Promise<IDBDatabase> {
  if (database) return database;
  const pending = new Promise<IDBDatabase>((resolve, reject) => {
    const operation = indexedDB.open(DB_NAME, 1);
    operation.onupgradeneeded = () => {
      operation.result.createObjectStore("metadata");
      operation.result.createObjectStore("messages", { keyPath: "id" });
    };
    operation.onsuccess = () => {
      const db = operation.result;
      owners.set(db, pending);
      db.onclose = () => {
        if (database === pending) database = undefined;
      };
      db.onversionchange = () => {
        if (database === pending) database = undefined;
        db.close();
      };
      resolve(db);
    };
    operation.onerror = () => {
      if (database === pending) database = undefined;
      reject(operation.error);
    };
  });
  database = pending;
  return pending;
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
  const [metadata, records] = await readRecords(db);
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
      const [oldMetadata, oldRows] = await readRecords(db);
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
      // Serialize/validate before opening the write transaction. Large snapshots
      // must not keep a native transaction idle while JS prepares its payload.
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
      if (totalBytes > CACHE_HARD_LIMIT) throw new Error("Reading cache exceeds the 128 MiB limit");
      const plainMetadata = JSON.parse(metadataJson);
      // pagehide can close the read connection while its transaction completes.
      const writeDb = await open();
      if (admitted !== generation || !isCacheAuthorized()) return;
      const transaction = writeDb.transaction(["metadata", "messages"], "readwrite");
      const done = transactionDone(transaction, "write");
      const messages = transaction.objectStore("messages");
      try {
        if (!sameScope) messages.clear();
        const retainedIds = new Set(kept.map((row) => row.id));
        for (const old of oldById.values()) if (!retainedIds.has(old.id)) messages.delete(old.id);
        for (const row of kept) if (oldById.get(row.id)?.json !== row.json) messages.put(row);
        transaction.objectStore("metadata").put(plainMetadata, "current");
        transaction.commit();
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
    const done = transactionDone(transaction, "clear");
    transaction.objectStore("metadata").clear();
    transaction.objectStore("messages").clear();
    transaction.commit();
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
