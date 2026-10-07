import type { EntryRecord } from "@earendil-works/pi-durable";
import { generateUnifiedPatch } from "@earendil-works/pi-coding-agent";
import type { AgentTurnArtifacts, DurableFileChange } from "./agent-turn-file-changes";
import type { SentFileDescriptor, SiteDescriptor } from "@/shared/types";
import { decodeRuntimeNotice } from "./runtime-notices";

export type RuntimeResultArtifacts = AgentTurnArtifacts & {
  battyFileChanges?: DurableFileChange[];
};

/** Only the answered input's own transcript contributes report artifacts. */
export function runtimeResultArtifacts(entries: readonly EntryRecord[]): RuntimeResultArtifacts {
  const files = new Map<string, SentFileDescriptor>();
  const sites = new Map<string, SiteDescriptor>();
  const changes = new Map<string, DurableFileChange>();
  const mutations: DurableFileChange[] = [];
  const mutationKeys = new Set<string>();
  const deliveredChanges = new Map<string, string>();
  const add = (details: RuntimeResultArtifacts | undefined) => {
    for (const file of details?.sentFiles ?? []) files.set(file.id, file);
    for (const site of details?.sites ?? []) sites.set(site.id, site);
    for (const change of details?.fileChanges ?? [])
      deliveredChanges.set(change.path, change.patch);
    for (const change of details?.battyFileChanges ?? []) {
      const key = `${change.path}:${change.order}`;
      if (change.order !== undefined && mutationKeys.has(key)) continue;
      mutationKeys.add(key);
      mutations.push(change);
    }
  };
  for (const entry of entries) {
    for (const message of entry.model ?? []) {
      if (message.role === "user") {
        const notice = decodeRuntimeNotice(message.content);
        add(notice?.data?.runtimeResultArtifacts as RuntimeResultArtifacts | undefined);
      }
      if (message.role === "toolResult") add(message.details as RuntimeResultArtifacts | undefined);
    }
  }
  // Child reports can arrive after later parent edits. Keep raw snapshots across
  // nesting so interleaved mutations remain sortable, rather than flattening ranges.
  mutations.sort((left, right) => (left.order ?? 0) - (right.order ?? 0));
  for (const change of mutations) {
    const first = changes.get(change.path);
    changes.set(change.path, { ...change, before: first ? first.before : change.before });
  }
  for (const change of changes.values()) {
    if (change.before === change.after) deliveredChanges.delete(change.path);
    else
      deliveredChanges.set(
        change.path,
        generateUnifiedPatch(change.path, change.before ?? "", change.after),
      );
  }
  return {
    ...(files.size ? { sentFiles: [...files.values()] } : {}),
    ...(sites.size ? { sites: [...sites.values()] } : {}),
    ...(mutations.length ? { battyFileChanges: mutations } : {}),
    ...(deliveredChanges.size
      ? { fileChanges: [...deliveredChanges].map(([path, patch]) => ({ path, patch })) }
      : {}),
  };
}
