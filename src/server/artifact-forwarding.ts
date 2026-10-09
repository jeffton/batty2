import { createHash } from "node:crypto";
import { Type } from "typebox";
import { defineTool, type Cursor, type EntryRecord } from "@earendil-works/pi-durable";
import type { JsonValue } from "@earendil-works/chord";
import type { AgentTurnArtifacts } from "./agent-turn-file-changes";
import { decodeRuntimeNotice } from "./runtime-notices";

export const ARTIFACT_FORWARDING_INSTRUCTION =
  "Diffs and sites belong to the execution scope that produced them. To attach selected existing diffs or sites from a child report to your own response, call attach-artifacts with the listed refs. Links or copied patch text do not forward response metadata. Do not automatically forward every draft. This reuses the saved objects; do not rerun actions or reconstruct diffs.";

export function artifactRefs(artifacts: AgentTurnArtifacts = {}) {
  return [
    ...(artifacts.fileChanges ?? []).map((diff) => ({ kind: "diff" as const, value: diff })),
    ...(artifacts.sites ?? []).map((site) => ({ kind: "site" as const, value: site })),
  ].map((item) => ({
    ...item,
    ref: `${item.kind}:${createHash("sha256").update(JSON.stringify(item.value)).digest("hex")}`,
  }));
}

export function reportWithArtifacts(text: string, artifacts: AgentTurnArtifacts = {}): string {
  const refs = artifactRefs(artifacts);
  if (!refs.length) return text;
  return [
    text,
    "Existing response artifacts available for explicit forwarding:",
    ...refs.map(({ ref, kind, value }) =>
      JSON.stringify({
        ref,
        kind,
        ...(kind === "diff" ? { path: value.path } : { name: value.name, url: value.url }),
      }),
    ),
    ARTIFACT_FORWARDING_INSTRUCTION,
  ].join("\n\n");
}

type ArtifactDetails = AgentTurnArtifacts & {
  calls?: Array<AgentTurnArtifacts & { details?: AgentTurnArtifacts }>;
};

export function artifactsFromModelMessages(
  messages: readonly NonNullable<EntryRecord["model"]>[number][],
): AgentTurnArtifacts[] {
  return messages.flatMap((message) => {
    if (message.role === "user") {
      const notice = decodeRuntimeNotice(message.content);
      return notice?.data?.runtimeResultArtifacts
        ? [notice.data.runtimeResultArtifacts as AgentTurnArtifacts]
        : [];
    }
    if (message.role !== "toolResult") return [];
    const details = message.details as ArtifactDetails | undefined;
    return [details ?? {}, ...(details?.calls ?? []).map((call) => call.details ?? call)];
  });
}

export function mergeResponseArtifacts(...sources: AgentTurnArtifacts[]): AgentTurnArtifacts {
  const unique = new Map(
    sources.flatMap((source) => artifactRefs(source)).map((item) => [item.ref, item]),
  );
  const items = [...unique.values()];
  const fileChanges = items.flatMap((item) => (item.kind === "diff" ? [item.value] : []));
  const sites = items.flatMap((item) => (item.kind === "site" ? [item.value] : []));
  return { ...(fileChanges.length ? { fileChanges } : {}), ...(sites.length ? { sites } : {}) };
}

export function forwardedResponseArtifacts(entries: readonly EntryRecord[]): AgentTurnArtifacts {
  const diffs = new Map<string, NonNullable<AgentTurnArtifacts["fileChanges"]>[number]>();
  const sites = new Map<string, NonNullable<AgentTurnArtifacts["sites"]>[number]>();
  for (const entry of entries) {
    for (const message of entry.model ?? []) {
      if (message.role !== "toolResult") continue;
      const forwarded = (message.details as { forwardedArtifacts?: AgentTurnArtifacts })
        ?.forwardedArtifacts;
      for (const item of artifactRefs(forwarded)) {
        if (item.kind === "diff") diffs.set(item.ref, item.value);
        else sites.set(item.ref, item.value);
      }
    }
  }
  return {
    ...(diffs.size ? { fileChanges: [...diffs.values()] } : {}),
    ...(sites.size ? { sites: [...sites.values()] } : {}),
  };
}

export function createAttachArtifactsTool() {
  return defineTool({
    name: "attach-artifacts",
    description: `Attach selected existing diffs and sites from reports to the current response. ${ARTIFACT_FORWARDING_INSTRUCTION}`,
    parameters: Type.Object(
      {
        refs: Type.Array(Type.String(), {
          minItems: 1,
          description:
            "Stable diff/site refs listed in a received report. Only artifacts already present in this conversation can be forwarded.",
        }),
      },
      { additionalProperties: false },
    ),
    replay: "safe",
    execute: async (args, api, ctx) => {
      const wanted = new Set(args.refs);
      const found = new Map<string, ReturnType<typeof artifactRefs>[number]>();
      await api.commit(async (tx) => {
        let cursor: Cursor | undefined;
        do {
          const page = await tx.scanEntries({ conversationId: api.conversationId }, 200, cursor);
          for (const entry of page.items) {
            for (const artifacts of artifactsFromModelMessages(entry.model ?? [])) {
              for (const item of artifactRefs(artifacts)) {
                if (wanted.has(item.ref)) found.set(item.ref, item);
              }
            }
          }
          cursor = page.next;
        } while (cursor && found.size < wanted.size);
      }, ctx);
      const missing = [...wanted].filter((ref) => !found.has(ref));
      if (missing.length)
        throw new Error(`Artifact refs not received in this conversation: ${missing.join(", ")}`);
      const selected = [...wanted].map((ref) => found.get(ref)!);
      const fileChanges = selected.flatMap((item) => (item.kind === "diff" ? [item.value] : []));
      const sites = selected.flatMap((item) => (item.kind === "site" ? [item.value] : []));
      return {
        content: [
          {
            type: "text" as const,
            text: `Attached ${selected.length} existing artifacts to this response.`,
          },
        ],
        details: {
          forwardedArtifacts: { fileChanges, sites },
          ...(fileChanges.length ? { fileChanges } : {}),
          ...(sites.length ? { sites } : {}),
        } as unknown as JsonValue,
      };
    },
  });
}
