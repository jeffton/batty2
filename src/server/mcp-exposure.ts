import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { Context } from "@earendil-works/chord";
import {
  AgentDoc,
  configure,
  defineDoc,
  defineExtension,
  defineTool,
  type AgentState,
  type Conversation,
  type Registry,
  type ToolExecutionApi,
  type ToolRegistration,
} from "@earendil-works/pi-durable";
import { Type } from "typebox";
import type { McpService } from "./mcp-service";

export const McpToolSelection = defineDoc<{ loaded: Record<string, string[]> }>({
  kind: "batty.mcp-tool-selection",
  version: 1,
  scope: "conversation",
  history: "latest",
  fork: "current",
  initial: () => ({ loaded: {} }),
});
const prefix = "batty-mcp-workspace-";

/** Durable has no exposure flag: keep MCP extensions outside host defaults and select exact tools per conversation. */
export function createMcpExposure(mcp: McpService) {
  let registry: Registry | undefined;
  const install = async (cwd: string) => {
    if (!registry) throw new Error("Tools must bindRegistry() before exposing MCP model tools");
    const catalog = await mcp.catalog(cwd);
    const extension = defineExtension({
      name: `${prefix}${createHash("sha256").update(cwd).digest("hex").slice(0, 16)}`,
      tools: catalog
        .filter((entry) => entry.exposure === "direct" || entry.exposure === "deferred")
        .map((entry) => entry.tool),
    });
    registry.install(extension);
    return { catalog, extension };
  };
  const selection = (catalog: Awaited<ReturnType<McpService["catalog"]>>, loaded: string[]) =>
    catalog
      .filter(
        (entry) =>
          entry.exposure === "direct" ||
          (entry.exposure === "deferred" && loaded.includes(entry.tool.name)),
      )
      .map((entry) => entry.tool);
  const baseTools = (tools: readonly ToolRegistration[]) =>
    tools.filter((tool) => !tool.name.startsWith("mcp__"));

  const search = defineTool({
    name: "tool_search",
    description:
      "Find deferred MCP tools and load their declarations for direct model calls. Codemode-only tools are discoverable inside codemode; hidden tools are unreachable.",
    parameters: Type.Object({
      query: Type.String(),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 50 })),
    }),
    replay: "safe",
    execute: async ({ query, limit }, api, ctx) => {
      const agent = await api.agent(ctx);
      if (!agent.cwd) throw new Error("MCP tool search requires a conversation working directory");
      const { catalog, extension } = await install(agent.cwd);
      const words = query.toLowerCase().split(/\s+/).filter(Boolean);
      const matches = catalog
        .filter(
          (entry) =>
            entry.exposure === "deferred" &&
            words.every((word) =>
              `${entry.tool.name} ${entry.tool.description}`.toLowerCase().includes(word),
            ),
        )
        .slice(0, limit ?? 5);
      await api.commit(async (tx) => {
        const state = await tx.doc(McpToolSelection, api.conversationId);
        const loaded =
          state.loaded[agent.cwd!] ??
          (agent.extensions.some((value) => value.name === extension.name)
            ? catalog
                .filter(
                  (entry) =>
                    entry.exposure === "deferred" &&
                    agent.tools.some((tool) => tool.name === entry.tool.name),
                )
                .map((entry) => entry.tool.name)
            : []);
        state.loaded[agent.cwd!] = [
          ...new Set([...loaded, ...matches.map((entry) => entry.tool.name)]),
        ];
        await configure(tx, api.conversationId, {
          extensions: [
            ...agent.extensions.filter((value) => !value.name.startsWith(prefix)),
            extension,
          ],
          tools: [...baseTools(agent.tools), ...selection(catalog, state.loaded[agent.cwd!]!)],
        });
      }, ctx);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              matches.map(({ tool }) => ({
                name: tool.name,
                description: tool.description,
                parameters: tool.parameters,
              })),
            ),
          },
        ],
        details: { loadedTools: matches.map((entry) => entry.tool.name) },
      };
    },
  });
  return {
    search,
    bindRegistry(value: Registry) {
      registry = value;
    },
    async installScopes(cwds: readonly string[]) {
      await Promise.all([...new Set(cwds)].map(install));
    },
    async prepareAgent(
      cwd: string,
      agent: import("@earendil-works/pi-durable").Agent,
      _ctx: Context,
    ): Promise<import("@earendil-works/pi-durable").AgentChange> {
      const { catalog, extension } = await install(cwd);
      const inherited = agent.extensions.some((value) => value.name === extension.name)
        ? agent.tools.map((tool) => tool.name)
        : [];
      return {
        extensions: [
          ...agent.extensions.filter((value) => !value.name.startsWith(prefix)),
          extension,
        ],
        tools: [...baseTools(agent.tools), ...selection(catalog, inherited)],
      };
    },
    async syncConversation(conversation: Conversation, ctx: Context) {
      const clone = (state: unknown): AgentState => JSON.parse(JSON.stringify(state));
      const read = () =>
        conversation.commit(async (tx) => clone(await tx.doc(AgentDoc, conversation.id)), ctx);
      while (true) {
        ctx.abortSignal?.throwIfAborted();
        const source = await read();
        if (!source.cwd) throw new Error("MCP exposure requires a conversation working directory");
        const { catalog, extension } = await install(source.cwd);
        // Catalogue loading is asynchronous. Never apply a scope calculated for
        // an inline agent after another commit restored the canonical agent.
        const expected = await conversation.commit(async (tx) => {
          const state = await tx.doc(AgentDoc, conversation.id);
          if (!isDeepStrictEqual(clone(state), source)) return undefined;
          // A fresh catalogue can remove a tool persisted in AgentDoc.tools.
          // Prune only unavailable MCP names before resolving the agent; unknown
          // base tools still fail normally, and old tool tasks are not fabricated.
          const scopeNames = Array.isArray(state.extensions)
            ? state.extensions
            : (state.extensions?.add ?? []);
          const available = new Set(
            scopeNames
              .filter((name) => name.startsWith(prefix))
              .flatMap(
                (name) =>
                  registry!
                    .snapshot()
                    .extension(name)
                    ?.tools?.map((tool) => tool.name) ?? [],
              ),
          );
          if (Array.isArray(state.tools))
            state.tools = state.tools.filter(
              (name) => !name.startsWith("mcp__") || available.has(name),
            );
          return clone(state);
        }, ctx);
        if (!expected) continue;
        let agent: import("@earendil-works/pi-durable").Agent;
        try {
          agent = await conversation.agent(ctx);
        } catch (error) {
          if (!isDeepStrictEqual(await read(), expected)) continue;
          throw error;
        }
        const applied = await conversation.commit(async (tx) => {
          const current = await tx.doc(AgentDoc, conversation.id);
          if (!isDeepStrictEqual(clone(current), expected)) return false;
          const state = await tx.doc(McpToolSelection, conversation.id);
          state.loaded[source.cwd!] ??= agent.extensions.some(
            (value) => value.name === extension.name,
          )
            ? catalog
                .filter(
                  (entry) =>
                    entry.exposure === "deferred" &&
                    agent.tools.some((tool) => tool.name === entry.tool.name),
                )
                .map((entry) => entry.tool.name)
            : [];
          await configure(tx, conversation.id, {
            extensions: [
              ...agent.extensions.filter((value) => !value.name.startsWith(prefix)),
              extension,
            ],
            tools: [
              ...baseTools(agent.tools),
              ...selection(catalog, state.loaded[source.cwd!] ?? []),
            ],
          });
          return true;
        }, ctx);
        if (applied) return;
      }
    },
  };
}
