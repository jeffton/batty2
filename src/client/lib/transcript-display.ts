import { easyModeMessage } from "@/client/lib/easy-mode";
import { isAttachmentOutputToolCall } from "@/client/lib/transcript";
import type { ToolDisplayState, TranscriptMessageView } from "@/client/lib/transcript";
import {
  hasNoReplyText,
  isTranscriptDetailsBlock,
  isTranscriptDetailsMessageRole,
} from "@/shared/chat-only-context";

interface DetailsToggle {
  sectionKey: string;
  expanded: boolean;
}

export type TranscriptDisplayEntry =
  | {
      kind: "message";
      entry: TranscriptMessageView;
      showTimestamp: boolean;
      detailsToggle?: DetailsToggle;
    }
  | ({ kind: "details-toggle" } & DetailsToggle);

export interface TranscriptDisplayResult {
  entries: TranscriptDisplayEntry[];
  latestExpandedSectionKey?: string;
}

interface TranscriptSection {
  key: string;
  startIndex: number;
  endIndex: number;
}

function transcriptSections(
  entries: TranscriptMessageView[],
  toolStatesByCallId: Map<string, ToolDisplayState>,
): TranscriptSection[] {
  const starts: number[] = [];
  let hasReply = false;
  entries.forEach((entry, index) => {
    // Runtime inputs can arrive between a tool call and its final reply. They
    // continue that work. After a reply, a notice starts independent work.
    if (
      index === 0 ||
      entry.message.role === "user" ||
      (entry.message.role === "custom" && hasReply)
    ) {
      starts.push(index);
      hasReply = false;
    }
    if (hasAssistantReply(collapsedMessage(entry, toolStatesByCallId))) {
      hasReply = true;
    }
  });

  return starts.map((startIndex, index) => ({
    key: `turn:${entries[startIndex]!.message.id}`,
    startIndex,
    endIndex: starts[index + 1] ?? entries.length,
  }));
}

function collapsedMessage(
  entry: TranscriptMessageView,
  toolStatesByCallId: Map<string, ToolDisplayState>,
): TranscriptMessageView | undefined {
  const original = entry.message;
  const source =
    original.role === "assistant" && hasNoReplyText(original.blocks)
      ? { ...original, blocks: original.blocks.filter((block) => block.type !== "text") }
      : original;
  const message = easyModeMessage(source, toolStatesByCallId);
  return message ? { ...entry, message } : undefined;
}

function hasExpandableDetails(entry: TranscriptMessageView): boolean {
  const message = entry.message;
  if (isTranscriptDetailsMessageRole(message.role)) return true;
  if (message.role === "assistant" && hasNoReplyText(message.blocks)) return true;

  return (
    "blocks" in message &&
    message.blocks.some(
      (block) =>
        isTranscriptDetailsBlock(block) &&
        (block.type !== "thinking" || block.thinking.trim().length > 0),
    )
  );
}

function hidesExpandableDetails(
  original: TranscriptMessageView,
  collapsed: TranscriptMessageView | undefined,
): boolean {
  if (!hasExpandableDetails(original)) {
    return false;
  }

  if (!collapsed) {
    return true;
  }

  const originalMessage = original.message;
  const collapsedMessage = collapsed.message;
  if (!("blocks" in originalMessage) || !("blocks" in collapsedMessage)) {
    return false;
  }

  return originalMessage.blocks.some(
    (block) =>
      (isTranscriptDetailsBlock(block) ||
        (originalMessage.role === "assistant" &&
          hasNoReplyText(originalMessage.blocks) &&
          block.type === "text")) &&
      !collapsedMessage.blocks.includes(block),
  );
}

function detailsToggle(section: TranscriptSection, expanded: boolean): DetailsToggle {
  return {
    sectionKey: section.key,
    expanded,
  };
}

function hasAssistantReply(entry: TranscriptMessageView | undefined): boolean {
  if (!entry || entry.message.role !== "assistant") {
    return false;
  }

  if (
    entry.message.stopReason === "error" ||
    entry.message.errorMessage?.trim() ||
    (entry.message.fileChanges?.length ?? 0) > 0 ||
    (entry.message.sentFiles?.length ?? 0) > 0 ||
    (entry.message.sites?.length ?? 0) > 0
  ) {
    return true;
  }

  if (
    entry.message.blocks.some((block) =>
      isAttachmentOutputToolCall(block, entry.toolStatesByCallId),
    )
  ) {
    return true;
  }

  if (entry.message.turnPhase !== "final") {
    return false;
  }

  return entry.message.blocks.some((block) => block.type === "text" || block.type === "image");
}

export function buildTranscriptDisplayEntries(
  entries: TranscriptMessageView[],
  toolStatesByCallId: Map<string, ToolDisplayState>,
  options: {
    alwaysShowDetails?: boolean;
    openDetailsSectionKey?: string | null;
    isStreaming?: boolean;
  } = {},
): TranscriptDisplayResult {
  if (options.alwaysShowDetails) {
    return {
      entries: entries.map((entry) => ({ kind: "message", entry, showTimestamp: false })),
      latestExpandedSectionKey: undefined,
    };
  }

  const sections = transcriptSections(entries, toolStatesByCallId);
  const latestSectionKey = options.isStreaming ? sections.at(-1)?.key : undefined;
  const displayEntries: TranscriptDisplayEntry[] = [];

  for (const section of sections) {
    const isRunning = section.key === latestSectionKey;
    const sectionEntries = entries.slice(section.startIndex, section.endIndex);
    // A durable run can persist an aborted generation before resuming after a
    // server restart. Keep that original in details, not as a second answer.
    // Task identity is required: unrelated replies must never supersede it.
    const resumedAbortIds = new Set(
      sectionEntries.flatMap((entry, index) => {
        const message = entry.message;
        if (
          message.role !== "assistant" ||
          message.stopReason !== "aborted" ||
          message.errorMessage ||
          !message.runTaskId
        )
          return [];
        const resumed = sectionEntries
          .slice(index + 1)
          .some(
            ({ message: next }) =>
              next.role === "assistant" &&
              next.runTaskId === message.runTaskId &&
              next.stopReason === "stop" &&
              next.turnPhase === "final" &&
              !next.errorMessage,
          );
        return resumed ? [message.id] : [];
      }),
    );
    const collapsedEntries = sectionEntries.map((entry) =>
      resumedAbortIds.has(entry.message.id)
        ? undefined
        : collapsedMessage(entry, toolStatesByCallId),
    );
    const lastReplyIndex = collapsedEntries.findLastIndex(hasAssistantReply);
    const isExpanded = isRunning || section.key === options.openDetailsSectionKey;
    const items = sectionEntries.map((entry, index) => {
      const collapsed = collapsedEntries[index];
      return {
        visibleEntry: isExpanded ? entry : collapsed,
        hidesDetails:
          resumedAbortIds.has(entry.message.id) || hidesExpandableDetails(entry, collapsed),
      };
    });
    const canToggle = !isRunning && items.some((item) => item.hidesDetails);

    items.forEach((item, index) => {
      const toggle =
        canToggle && index === lastReplyIndex ? detailsToggle(section, isExpanded) : undefined;

      if (item.visibleEntry) {
        displayEntries.push({
          kind: "message",
          entry: item.visibleEntry,
          showTimestamp: false,
          ...(toggle ? { detailsToggle: toggle } : {}),
        });
      }
    });
    if (canToggle && lastReplyIndex < 0) {
      displayEntries.push({ kind: "details-toggle", ...detailsToggle(section, isExpanded) });
    }
  }

  return {
    entries: displayEntries,
    latestExpandedSectionKey: latestSectionKey,
  };
}
