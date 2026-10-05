import { easyModeMessage } from "@/client/lib/easy-mode";
import { isAttachmentOutputToolCall } from "@/client/lib/transcript";
import type { ToolDisplayState, TranscriptMessageView } from "@/client/lib/transcript";
import {
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

function startsAnyTurn(entry: TranscriptMessageView): boolean {
  return entry.message.role === "user" || entry.message.role === "custom";
}

function transcriptSections(entries: TranscriptMessageView[]): TranscriptSection[] {
  const starts: number[] = [];
  entries.forEach((entry, index) => {
    if (index === 0 || startsAnyTurn(entry)) {
      starts.push(index);
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
  const message = easyModeMessage(entry.message, toolStatesByCallId);
  return message ? { ...entry, message } : undefined;
}

function hasExpandableDetails(entry: TranscriptMessageView): boolean {
  const message = entry.message;
  if (isTranscriptDetailsMessageRole(message.role)) return true;

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
    (block) => isTranscriptDetailsBlock(block) && !collapsedMessage.blocks.includes(block),
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

  const sections = transcriptSections(entries);
  const latestSectionKey = options.isStreaming ? sections.at(-1)?.key : undefined;
  const displayEntries: TranscriptDisplayEntry[] = [];

  for (const section of sections) {
    const isRunning = section.key === latestSectionKey;
    const sectionEntries = entries.slice(section.startIndex, section.endIndex);
    const collapsedEntries = sectionEntries.map((entry) =>
      collapsedMessage(entry, toolStatesByCallId),
    );
    const lastReplyIndex = collapsedEntries.findLastIndex(hasAssistantReply);
    // Without a reply there is nowhere to put a control. Keep notices, failed
    // tools and interrupted work accessible rather than silently dropping them.
    const isExpanded =
      isRunning || lastReplyIndex < 0 || section.key === options.openDetailsSectionKey;
    const items = sectionEntries.map((entry, index) => {
      const collapsed = collapsedEntries[index];
      return {
        visibleEntry: isExpanded ? entry : collapsed,
        hidesDetails: hidesExpandableDetails(entry, collapsed),
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
  }

  return {
    entries: displayEntries,
    latestExpandedSectionKey: latestSectionKey,
  };
}
