import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { cp, mkdir, readFile, readdir, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { acquireLock } from "../src/server/lock.js";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import type { Message } from "@earendil-works/pi-ai";
import {
  createRegistry,
  defineDocFamily,
  Harness,
  type Conversation,
  type JsonObject,
} from "@earendil-works/pi-durable";
import { openNodeSqliteDatabase } from "@earendil-works/pi-durable/storage/sqlite/node";
import { SqliteStorage } from "@earendil-works/pi-durable/storage/sqlite";

type OldEntry = {
  type: string;
  id?: string;
  timestamp?: string;
  customType?: string;
  data?: Record<string, unknown>;
  message?: Message;
};
export type ImportRecord = {
  path: string;
  line: number;
  sourceId: string;
  sessionId: string;
  timestamp: string;
  digest: string;
};
export type ImportPlan = {
  records: ImportRecord[];
  sessions: string[];
  bytes: number;
  messages: number;
  artifacts: string[];
};
const Receipts = defineDocFamily<
  { digest: string; entryId: number },
  { digest: string; entryId: number }
>({
  kind: "batty.roy-import",
  version: 1,
  family: true,
  scope: "conversation",
  history: "latest",
  fork: "initial",
  initial: (receipt) => receipt,
});

async function* lines(path: string) {
  let line = 0;
  let buffer = "";
  const parse = (text: string): OldEntry => {
    try {
      return JSON.parse(text) as OldEntry;
    } catch (error) {
      return { type: "import-corrupt-source", data: { rawLine: text, error: String(error) } };
    }
  };
  for await (const chunk of createReadStream(path, { encoding: "utf8" })) {
    buffer += chunk;
    let end;
    while ((end = buffer.indexOf("\n")) >= 0) {
      const text = buffer.slice(0, end);
      buffer = buffer.slice(end + 1);
      line++;
      if (text.trim()) yield { line, text, entry: parse(text) };
    }
  }
  if (buffer.trim()) yield { line: line + 1, text: buffer, entry: parse(buffer) };
}
export async function planRoyImport(source: string): Promise<ImportPlan> {
  const directory = join(source, "sessions", "roy");
  const records = new Map<string, ImportRecord>();
  const sessions: string[] = [];
  const artifacts = new Set<string>();
  let bytes = 0;
  let messages = 0;
  for (const filename of (await readdir(directory))
    .filter((file) => file.endsWith(".jsonl"))
    .sort()) {
    const path = join(directory, filename);
    let daily = false;
    let worker = false;
    let sessionId = filename;
    const candidates: ImportRecord[] = [];
    const references = new Set<string>();
    let fileMessages = 0;
    for await (const { line, text, entry } of lines(path)) {
      if (entry.type === "session") sessionId = entry.id!;
      if (entry.customType === "batty-cron-session" && entry.data?.kind === "daily") daily = true;
      if (
        entry.customType === "batty-subagent-session" ||
        entry.customType === "batty-cron-run-session"
      ) {
        worker = true;
        break;
      }
      // Batty writes binding metadata before the first message. Unmarked sessions are not daily history.
      if (entry.type === "message" && !daily) break;
      if (entry.type === "message") fileMessages++;
      const sourceId = entry.id ?? `${sessionId}:${line}`;
      candidates.push({
        path,
        line,
        sourceId,
        sessionId,
        timestamp: entry.timestamp ?? "1970-01-01T00:00:00.000Z",
        digest: createHash("sha256").update(text).digest("hex"),
      });
      for (const match of text.matchAll(/\/(?:api\/)?(uploads|sent-files)\/([^\s"?<>\\]+)/g)) {
        const pieces = match[2]!.split("/").map(decodeURIComponent);
        const count = match[1] === "uploads" ? 1 : 2;
        if (
          pieces.length >= count &&
          pieces
            .slice(0, count)
            .every((part) => /^[a-zA-Z0-9._-]+$/.test(part) && part !== "." && part !== "..")
        )
          references.add(join(match[1]!, ...pieces.slice(0, count)));
      }
      for (const match of text.matchAll(/\/(?:sites|site-preview)\/([0-9a-f-]{36})(?:\/|\\|")/gi))
        references.add(join("sites", match[1]!));
      for (const match of text.matchAll(/"siteId"\s*:\s*"([0-9a-f-]{36})"/gi))
        references.add(join("sites", match[1]!));
      for (const match of text.matchAll(/\.batty\/sites\/([0-9a-f-]{36})/gi))
        references.add(join("sites", match[1]!));
    }
    if (!daily || worker) continue;
    sessions.push(sessionId);
    bytes += (await stat(path)).size;
    messages += fileMessages;
    for (const candidate of candidates) {
      const previous = records.get(candidate.sourceId);
      if (previous && previous.digest !== candidate.digest)
        throw new Error(`Conflicting source entry ${candidate.sourceId} in ${path}`);
      if (!previous) records.set(candidate.sourceId, candidate);
    }
    for (const reference of references) artifacts.add(reference);
  }
  return {
    records: [...records.values()].sort(
      (a, b) =>
        a.timestamp.localeCompare(b.timestamp) ||
        a.sessionId.localeCompare(b.sessionId) ||
        a.line - b.line,
    ),
    sessions,
    bytes,
    messages,
    artifacts: [...artifacts].sort(),
  };
}

export async function importRoyPlan(
  plan: ImportPlan,
  main: Conversation,
  source: string,
  target: string,
  progress = console.log,
) {
  const cache = new Map<string, { lines: string[]; bytes: number }>();
  let cacheBytes = 0;
  async function sourceLines(path: string) {
    let file = cache.get(path);
    if (file) {
      cache.delete(path);
      cache.set(path, file);
      return file.lines;
    }
    const text = await readFile(path, "utf8");
    file = { lines: text.split("\n"), bytes: Buffer.byteLength(text) };
    while (cache.size && cacheBytes + file.bytes > 64 * 1024 * 1024) {
      const oldest = cache.keys().next().value!;
      cacheBytes -= cache.get(oldest)!.bytes;
      cache.delete(oldest);
    }
    cache.set(path, file);
    cacheBytes += file.bytes;
    return file.lines;
  }
  let liveHistory = false;
  let historyCursor: import("@earendil-works/pi-durable").Cursor | undefined;
  do {
    const page = await main.entries({}, 200, historyCursor, BACKGROUND_CONTEXT);
    liveHistory = page.items.some(
      (entry) =>
        (entry.model?.some((message) => message.role !== "system") ||
          entry.kind === "batty.input-admitted") &&
        (entry.data as { provenance?: { source?: string } } | undefined)?.provenance?.source !==
          "roy",
    );
    historyCursor = page.next;
  } while (!liveHistory && historyCursor);
  let imported = 0;
  let skipped = 0;
  for (let offset = 0; offset < plan.records.length; offset += 100) {
    const batch: { record: ImportRecord; raw: OldEntry }[] = [];
    for (const record of plan.records.slice(offset, offset + 100)) {
      const text = (await sourceLines(record.path))[record.line - 1]!;
      if (createHash("sha256").update(text).digest("hex") !== record.digest)
        throw new Error(`Source changed during import: ${record.path}:${record.line}`);
      let raw: OldEntry;
      try {
        raw = JSON.parse(text) as OldEntry;
      } catch (error) {
        raw = { type: "import-corrupt-source", data: { rawLine: text, error: String(error) } };
        progress(`Preserving malformed original record ${record.path}:${record.line}`);
      }
      batch.push({ record, raw });
    }
    await main.commit(async (tx) => {
      for (const { record, raw } of batch) {
        const receipt = await tx.doc(Receipts, main.id, record.sourceId, {
          digest: record.digest,
          entryId: 0,
        });
        if (receipt.digest !== record.digest)
          throw new Error(`Source receipt conflict: ${record.sourceId}`);
        if (receipt.entryId) {
          skipped++;
          continue;
        }
        if (liveHistory)
          throw new Error(
            "Roy import accepts new records only before live main-thread work begins",
          );
        const role = raw.message?.role;
        const kind =
          role === "user"
            ? "pi.user"
            : role === "assistant"
              ? "pi.assistant"
              : role === "toolResult"
                ? "pi.tool-result"
                : "batty.roy-artifact";
        const entry = await tx.appendEntry(main.id, {
          kind,
          ...(raw.type === "message" && raw.message && role !== "system"
            ? { model: [raw.message] }
            : {}),
          data: {
            diagnostics: [],
            provenance: {
              source: "roy",
              sessionId: record.sessionId,
              sourceId: record.sourceId,
              file: record.path,
              line: record.line,
            },
            original: raw,
          } as unknown as JsonObject,
        });
        receipt.entryId = entry.id;
        imported++;
      }
    }, BACKGROUND_CONTEXT);
    progress(
      `Roy import ${Math.min(offset + 100, plan.records.length)}/${plan.records.length}: ${imported} imported, ${skipped} already present`,
    );
  }
  if (plan.records.length) {
    const digest = createHash("sha256");
    for (const record of plan.records) digest.update(`${record.sourceId}:${record.digest}\n`);
    const completion = digest.digest("hex");
    await main.commit(async (tx) => {
      const receipt = await tx.doc(Receipts, main.id, `complete:${completion}`, {
        digest: completion,
        entryId: 0,
      });
      if (receipt.entryId) return;
      const head = await tx.appendEntry(main.id, { kind: "batty.archive-head", head: "self" });
      receipt.digest = completion;
      receipt.entryId = head.id;
    }, BACKGROUND_CONTEXT);
  }
  // Copy only directories referenced by selected daily entries. Original route identities are preserved.
  for (const artifact of plan.artifacts) {
    const from = join(source, artifact);
    try {
      await stat(from);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      progress(`Referenced artifact missing in original state: ${artifact}`);
      continue;
    }
    const to = join(target, artifact);
    await mkdir(dirname(to), { recursive: true });
    await cp(from, to, { recursive: true, force: false, errorOnExist: false });
  }
  return { imported, skipped, artifacts: plan.artifacts.length };
}

async function cli() {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");
  const positional = args.filter((arg) => !arg.startsWith("--"));
  const source = resolve(positional[0] ?? "/root/github/.batty");
  const target = resolve(positional[1] ?? "/var/lib/batty2/.batty");
  const plan = await planRoyImport(source);
  console.log(
    JSON.stringify(
      {
        source,
        target,
        dailySessions: plan.sessions.length,
        sourceBytes: plan.bytes,
        sourceMessages: plan.messages,
        uniqueRecords: plan.records.length,
        referencedArtifacts: plan.artifacts.length,
        dryRun,
      },
      null,
      2,
    ),
  );
  if (dryRun) return;
  await mkdir(target, { recursive: true });
  const release = await acquireLock(join(target, "runtime.lock"));
  const database = await openNodeSqliteDatabase(join(target, "runtime.sqlite"));
  await database.exec("PRAGMA synchronous = FULL");
  const harness = await Harness.open(
    await SqliteStorage.open(database),
    {
      models: createModels(),
      registry: createRegistry(),
      settings: { compaction: { enabled: false } },
    },
    BACKGROUND_CONTEXT,
  );
  try {
    const main = await harness.root(BACKGROUND_CONTEXT);
    console.log(await importRoyPlan(plan, main, source, target));
    // Never resume scheduler here. Memory bootstrapping is separately resumable at runtime.
  } finally {
    await harness.close(BACKGROUND_CONTEXT);
    await release();
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await cli();
