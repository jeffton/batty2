import type { SqliteDatabase } from "@earendil-works/pi-durable/storage/sqlite";
import { isMemoryNoise, type MemoryLeaf } from "./memory";

export type MemorySearchOptions = { query: string; limit?: number; includeTools?: boolean };

// A disposable read index of immutable original projections, never summaries.
export async function createMemorySearch(db: SqliteDatabase) {
  await db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS batty_memory_search USING fts5(
    text, conversation UNINDEXED, original_id UNINDEXED, date UNINDEXED, kind UNINDEXED,
    tokenize = 'unicode61 remove_diacritics 2'
  );
  CREATE TABLE IF NOT EXISTS batty_memory_search_cursor (
    conversation INTEGER PRIMARY KEY, next_id INTEGER NOT NULL
  ) STRICT;`);
  return {
    async cursor(conversation: number) {
      return (
        (
          await db.get<{ next_id: number }>(
            "SELECT next_id FROM batty_memory_search_cursor WHERE conversation = ?",
            conversation,
          )
        )?.next_id ?? 0
      );
    },
    async append(conversation: number, start: number, leaves: readonly MemoryLeaf[]) {
      await db.transaction(async (tx) => {
        const cursor =
          (
            await tx.get<{ next_id: number }>(
              "SELECT next_id FROM batty_memory_search_cursor WHERE conversation = ?",
              conversation,
            )
          )?.next_id ?? 0;
        if (cursor !== start) throw new Error("Memory search checkpoint changed");
        for (const [offset, leaf] of leaves.entries()) {
          if (!leaf.text.trim() || isMemoryNoise(leaf)) continue;
          await tx.run(
            "INSERT INTO batty_memory_search(text, conversation, original_id, date, kind) VALUES (?, ?, ?, ?, ?)",
            leaf.text,
            conversation,
            start + offset,
            leaf.date,
            leaf.kind,
          );
        }
        await tx.run(
          `INSERT INTO batty_memory_search_cursor VALUES (?, ?)
          ON CONFLICT(conversation) DO UPDATE SET next_id = excluded.next_id`,
          conversation,
          start + leaves.length,
        );
      });
    },
    async search(conversation: number, options: MemorySearchOptions) {
      if (options.query.length > 256) throw new Error("Search query exceeds 256 characters");
      const terms = options.query.match(/[\p{L}\p{N}_]+/gu) ?? [];
      if (!terms.length || terms.length > 12) throw new Error("Search requires 1–12 words");
      const limit = options.limit ?? 8;
      if (!Number.isInteger(limit) || limit < 1 || limit > 20)
        throw new Error("Search limit must be 1–20");
      const rows = await db.all<{
        id: number;
        date: string;
        kind: MemoryLeaf["kind"];
        snippet: string;
      }>(
        `SELECT CAST(original_id AS INTEGER) AS id, date, kind,
          snippet(batty_memory_search, 0, '[', ']', ' … ', 48) AS snippet
         FROM batty_memory_search WHERE batty_memory_search MATCH ? AND conversation = ?
         ${options.includeTools ? "" : "AND kind IN ('user', 'talk', 'note')"}
         ORDER BY rowid DESC LIMIT ?`,
        terms.map((term) => `"${term}"`).join(" AND "),
        conversation,
        limit,
      );
      return rows.map((row) => ({ ...row, snippet: row.snippet.slice(0, 800) }));
    },
  };
}
export type MemorySearch = Awaited<ReturnType<typeof createMemorySearch>>;
