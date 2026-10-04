import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
  ModelRuntime,
  readStoredCredential,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import {
  createRegistry,
  Harness,
  type Conversation,
  type ConversationId,
  type EntryRecord,
  type EntryId,
  type Cursor,
  type Storage,
  type SubmissionRecord,
  type ConversationView,
  type LiveState,
  type InboxState,
} from "@earendil-works/pi-durable";
import { openNodeSqliteDatabase } from "@earendil-works/pi-durable/storage/sqlite/node";
import { SqliteStorage } from "@earendil-works/pi-durable/storage/sqlite";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { getSupportedThinkingLevels, type ModelThinkingLevel } from "@earendil-works/pi-ai";
import type { AppConfig } from "./config";
import { stateDirPath } from "./options";
import { listWorkspaces } from "./workspaces";
import { normalizeMessage, normalizeBlocks } from "./pi-state";
import { ProviderAuthService } from "./provider-auth";
import { ProviderUsageService } from "./provider-usage";
import { createTools } from "./tools";
import { createOrchestration } from "./orchestration";
import { createMemory, type MemoryConfig } from "./memory";
import { createResources } from "./resources";
import type { SessionState, SessionMessagesPage, UiMessage, ModelOption } from "@/shared/types";

export const context = BACKGROUND_CONTEXT;
const PAGE_SIZE = 120;

export function entryMessages(entries: readonly EntryRecord[]): UiMessage[] {
  return entries.flatMap((entry) => {
    if (entry.model?.length)
      return entry.model.flatMap((message, index) => {
        const normalized = normalizeMessage(message as AgentMessage, index);
        if (!normalized) return [];
        normalized.id = index ? `${entry.id}:${index}` : String(entry.id);
        return [normalized];
      });
    const data = entry.data as Record<string, unknown> | undefined;
    const original = data?.original as Record<string, unknown> | undefined;
    if (original?.type === "custom_message") {
      const message = normalizeMessage(
        {
          role: "custom",
          customType: original.customType,
          content: original.content,
          display: original.display,
          details: original.details,
          timestamp: Date.parse(String(original.timestamp)),
        } as unknown as AgentMessage,
        0,
      );
      if (message) {
        message.id = String(entry.id);
        return [message];
      }
    }
    if (data && typeof data.text === "string")
      return [
        {
          id: String(entry.id),
          role: "custom" as const,
          customType: entry.kind,
          timestamp: typeof data.timestamp === "number" ? data.timestamp : 0,
          text: data.text,
          data,
        },
      ];
    return [];
  });
}

export async function historyPage(
  storage: Storage,
  conversationId: ConversationId,
  before: string | undefined,
  limit: number,
) {
  const query = {
    conversationId,
    ...(before ? { maxEntryId: (Number(before.split(":")[0]) - 1) as EntryId } : {}),
  };
  const target = Math.min(limit, 500);
  let cursor: Cursor | undefined;
  let oldest: EntryId | undefined;
  const messages: UiMessage[] = [];
  do {
    const page = await storage.scanEntries(
      query,
      Math.max(1, target - messages.length),
      cursor,
      context,
    );
    oldest = page.items.at(-1)?.id ?? oldest;
    messages.unshift(...entryMessages([...page.items].reverse()));
    cursor = page.next;
  } while (messages.length < target && cursor);
  return {
    messages,
    hasMoreMessages: cursor !== undefined,
    nextBefore: oldest === undefined ? undefined : String(oldest),
  };
}

function visibleCount(entry: EntryRecord): number {
  if (entry.model?.length)
    return entry.model.filter(
      (message) =>
        message.role !== "system" && (message as { display?: boolean }).display !== false,
    ).length;
  const data = entry.data as Record<string, unknown> | undefined;
  const original = data?.original as Record<string, unknown> | undefined;
  return typeof data?.text === "string" ||
    (original?.type === "custom_message" && original.display !== false)
    ? 1
    : 0;
}

export class Runtime {
  readonly streamId = randomUUID();
  private revision = 0;
  private readonly messageCounts = new Map<number, number>();
  private readonly clientIdsByEntry = new Map<string, string>();
  private readonly clientIdsBySubmission = new Map<number, string>();
  private rememberSubmission(record: SubmissionRecord): void {
    if (!record.requestId) return;
    this.clientIdsBySubmission.set(record.id, record.requestId);
    if (record.entry !== undefined)
      this.clientIdsByEntry.set(String(record.entry), record.requestId);
  }
  private constructor(
    readonly config: AppConfig,
    readonly models: ModelRuntime,
    readonly harness: Harness,
    readonly storage: Storage,
    readonly main: Conversation,
    readonly tools: Awaited<ReturnType<typeof createTools>>,
    readonly orchestration: ReturnType<typeof createOrchestration>,
    readonly memory: ReturnType<typeof createMemory>,
    readonly resources: ReturnType<typeof createResources>,
    readonly providerAuth: ProviderAuthService,
    readonly providerUsage: ProviderUsageService,
  ) {}

  static async open(
    config: AppConfig,
    {
      resume = true,
      beforeStart,
    }: { resume?: boolean; beforeStart?: (runtime: Runtime) => void | Promise<void> } = {},
  ): Promise<Runtime> {
    const dir = stateDirPath(config.battyDir);
    await fs.mkdir(dir, { recursive: true });
    const authPath = process.env.BATTY_PROVIDER_AUTH_PATH ?? path.join(dir, "auth.json");
    const models = await ModelRuntime.create({
      authPath,
      modelsPath: path.join(dir, "models.json"),
      modelsStorePath: path.join(dir, "models-store.json"),
      allowModelNetwork: true,
    });
    const registry = createRegistry();
    const tools = await createTools(config);
    const orchestration = createOrchestration(config);
    const memory = createMemory(
      {
        memoryModel: process.env.BATTY_MEMORY_MODEL ?? "openai-codex/gpt-6-luna",
        memoryReasoning: (process.env.BATTY_MEMORY_REASONING ??
          "low") as MemoryConfig["memoryReasoning"],
      },
      models,
    );
    registry.install(tools.extension);
    registry.install(orchestration.extension);
    registry.install(memory.extension);
    const resources = createResources(config);
    registry.install(resources.extension);
    const baseExtensions = registry.snapshot().installed();
    tools.bindRegistry(registry);
    const workspaces = await listWorkspaces(config);
    await tools.installMcpScopes(workspaces.map((workspace) => workspace.path));
    const database = await openNodeSqliteDatabase(path.join(dir, "runtime.sqlite"));
    await database.exec("PRAGMA synchronous = FULL");
    const storage = await SqliteStorage.open(database);
    const harness = await Harness.open(
      storage,
      {
        models,
        registry,
        settings: {
          extensions: baseExtensions,
          compaction: { enabled: true },
          toolExecution: "parallel",
          stream: { timeoutMs: 300_000 },
        },
        env: ({ cwd }) => new NodeExecutionEnv({ cwd: cwd ?? config.selfPath }),
        onReport: (error) => console.error("Durable runtime", error),
      },
      context,
    );
    const cwd = workspaces.find((workspace) => workspace.isAssistant)?.path ?? config.selfPath;
    const main = await harness.root(context, {
      agent: {
        model: {
          provider: config.defaultProvider ?? "openai-codex",
          modelId: config.defaultModel ?? "gpt-6.1-sol",
        },
        thinkingLevel: (config.defaultThinkingLevel ?? "medium") as ModelThinkingLevel,
        cwd,
      },
    });
    if (!(await main.agent(context)).model) {
      await main.configure(
        {
          model: {
            provider: config.defaultProvider ?? "openai-codex",
            modelId: config.defaultModel ?? "gpt-6.1-sol",
          },
          thinkingLevel: (config.defaultThinkingLevel ?? "medium") as ModelThinkingLevel,
          cwd,
        },
        context,
      );
    }
    tools.bindHarness(harness);
    await tools.syncConversation(main, context);
    orchestration.setPrepareAgent((cwd, agent, ctx) => tools.prepareAgent(cwd, agent, ctx));
    orchestration.setContextProvider((parentId, mode) => memory.contextFor(parentId, mode));
    tools.registerTools([
      ...(orchestration.extension.tools ?? []),
      ...(memory.extension.tools ?? []),
    ]);
    await memory.bind(harness, main);
    const streamSimple = models.streamSimple.bind(models);
    models.streamSimple = (model, request, options) => {
      memory.validateRequest(request, options);
      return streamSimple(model, request, options);
    };
    const settings = SettingsManager.create(cwd, dir);
    const providerAuth = new ProviderAuthService(
      models,
      (id) => readStoredCredential(id, authPath),
      async () => {
        const id = settings.getOrCreateDeviceId();
        await settings.flush();
        return id;
      },
    );
    const runtime = new Runtime(
      config,
      models,
      harness,
      storage,
      main,
      tools,
      orchestration,
      memory,
      resources,
      providerAuth,
      new ProviderUsageService(models, (id) => readStoredCredential(id, authPath)),
    );
    harness.subscribeCommits((publication) => {
      for (const change of publication.changes)
        if (change.type === "submission") runtime.rememberSubmission(change.value);
        else if (change.type === "entry")
          runtime.messageCounts.set(
            change.value.conversationId,
            (runtime.messageCounts.get(change.value.conversationId) ?? 0) +
              visibleCount(change.value),
          );
    });
    let cursor: Cursor | undefined;
    do {
      const page = await storage.scanSubmissions({ conversationId: main.id }, 500, cursor, context);
      for (const submission of page.items) runtime.rememberSubmission(submission);
      cursor = page.next;
    } while (cursor);
    let conversationCursor: Cursor | undefined;
    do {
      const conversations = await storage.scanConversations({}, 500, conversationCursor, context);
      for (const conversation of conversations.items) {
        let entryCursor: Cursor | undefined;
        let count = 0;
        do {
          const page = await storage.scanEntries(
            { conversationId: conversation.id },
            200,
            entryCursor,
            context,
          );
          count += page.items.reduce((total, entry) => total + visibleCount(entry), 0);
          entryCursor = page.next;
        } while (entryCursor);
        runtime.messageCounts.set(conversation.id, count);
      }
      conversationCursor = conversations.next;
    } while (conversationCursor);
    // bind() admits due cron jobs and can resume the harness itself. Install
    // completion observers before that startup boundary, not only before resume.
    await beforeStart?.(runtime);
    await orchestration.bind(harness, main);
    if (resume) harness.resume();
    return runtime;
  }

  async conversation(id: string): Promise<Conversation> {
    const conversation =
      id === "main"
        ? this.main
        : await this.harness.conversation(Number(id) as ConversationId, context);
    if (!conversation) throw Object.assign(new Error("Session not found"), { statusCode: 404 });
    return conversation;
  }

  async listModels(): Promise<ModelOption[]> {
    return (await this.models.getAvailable()).map((model) => ({
      id: `${model.provider}/${model.id}`,
      label: `${model.name} · ${model.provider}`,
      provider: model.provider,
      reasoning: model.reasoning,
      thinkingLevels: getSupportedThinkingLevels(model),
      supportsImages: model.input.includes("image"),
    }));
  }

  nextRevision(): number {
    return ++this.revision;
  }

  async state(id = "main", view?: ConversationView, includeHistory = true): Promise<SessionState> {
    const conversation = await this.conversation(id);
    const ownedView = view ? undefined : await conversation.viewState(context);
    const value = view ?? ownedView!.value;
    const agent = await conversation.agent(context);
    const live = value.docs["pi.live"] as unknown as LiveState;
    const inbox = value.docs["pi.inbox"] as unknown as InboxState;
    const workspaces = await listWorkspaces(this.config);
    const workspace = workspaces.find((item) => item.path === agent.cwd);
    const model = agent.model && this.models.getModel(agent.model.provider, agent.model.modelId);
    const history = includeHistory
      ? await historyPage(this.storage, conversation.id, undefined, PAGE_SIZE)
      : undefined;
    const recentEntries = value.entries.slice(-PAGE_SIZE);
    const all = history?.messages ?? [];
    const totalMessageCount = this.messageCounts.get(conversation.id) ?? all.length;
    for (const message of all)
      if (message.role === "user") message.clientMessageId = this.clientIdsByEntry.get(message.id);
    const activeAssistant = live?.generation?.message
      ? normalizeMessage(
          live.generation.message as unknown as AgentMessage,
          Number.MAX_SAFE_INTEGER,
        )
      : undefined;
    const state: SessionState = {
      id: String(conversation.id),
      sessionId: String(conversation.id),
      path: `durable:${conversation.id}`,
      workspaceId: workspace?.id ?? "batty2",
      cwd: agent.cwd ?? this.config.selfPath,
      model: agent.model ? `${agent.model.provider}/${agent.model.modelId}` : undefined,
      modelLabel: model?.name,
      thinkingLevel: agent.thinkingLevel,
      availableThinkingLevels: model ? getSupportedThinkingLevels(model) : ["off"],
      isStreaming: Boolean(live?.run),
      isCompacting:
        Boolean(live?.compactions?.length) ||
        (conversation.id === this.main.id &&
          (this.memory.status().pending > 0 || !!this.memory.status().error)),
      pendingMessageCount: inbox?.items?.length ?? 0,
      queuedPrompts: (inbox?.items ?? []).flatMap((item) =>
        item.mode === "write"
          ? []
          : [
              {
                kind: item.mode,
                index: item.id,
                clientMessageId: this.clientIdsBySubmission.get(item.id),
                text:
                  typeof item.content === "string"
                    ? item.content
                    : item.content
                        .flatMap((part) => (part.type === "text" ? [part.text] : []))
                        .join("\n"),
              },
            ],
      ),
      updatedAt: all.at(-1)?.timestamp ?? Date.now(),
      contextTokens: null,
      contextWindow: model?.contextWindow ?? null,
      contextPercent: null,
      totalMessageCount,
      hasMoreMessages: totalMessageCount > all.length,
      messagesDetailLevel: "full",
      messages: all.slice(-PAGE_SIZE),
      activeAssistant: activeAssistant?.role === "assistant" ? activeAssistant : undefined,
      activeTools: (live?.tools ?? [])
        .filter((tool) => tool.status !== "done")
        .map((tool) => {
          const call = recentEntries
            .flatMap((entry) => entry.model ?? [])
            .flatMap((message) => (message.role === "assistant" ? message.content : []))
            .find((block) => block.type === "toolCall" && block.id === tool.callId);
          return {
            toolCallId: tool.callId,
            toolName: tool.name,
            args: call?.type === "toolCall" ? call.arguments : {},
            blocks: normalizeBlocks(tool.output ?? ""),
            status: "running" as const,
            isError: false,
            details: tool.details as Record<string, unknown> | undefined,
          };
        }),
      title: conversation.id === this.main.id ? "Batty" : "Subagent",
      isSubagentSession: conversation.id !== this.main.id,
      isCronSession: (await this.orchestration.metadata(conversation.id))?.isCron,
      streamId: this.streamId,
      revision: this.nextRevision(),
    };
    ownedView?.dispose();
    return state;
  }

  async messages(id: string, before?: string, limit = PAGE_SIZE): Promise<SessionMessagesPage> {
    const conversation = await this.conversation(id);
    const page = await historyPage(this.storage, conversation.id, before, limit);
    for (const message of page.messages)
      if (message.role === "user") message.clientMessageId = this.clientIdsByEntry.get(message.id);
    return {
      ...page,
      totalMessageCount: this.messageCounts.get(conversation.id) ?? page.messages.length,
    };
  }

  async setModel(modelId: string): Promise<void> {
    const slash = modelId.indexOf("/");
    const provider = modelId.slice(0, slash),
      modelIdPart = modelId.slice(slash + 1);
    if (!this.models.getModel(provider, modelIdPart)) throw new Error("Unknown model");
    await this.main.configure({ model: { provider, modelId: modelIdPart } }, context);
  }

  async close(): Promise<void> {
    await this.orchestration.close();
    await this.providerAuth.dispose();
    await this.harness.close(context);
    await this.memory.close();
    await this.tools.close();
  }
}
