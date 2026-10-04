import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { Context } from "@earendil-works/chord";
import {
  AgentDoc,
  configure,
  defineExtension,
  defineTool,
  type AgentState,
  type Conversation,
  type Registry,
  type ToolRegistration,
} from "@earendil-works/pi-durable";
import { Type } from "typebox";
import type { McpService } from "./mcp-service";

const prefix = "batty-mcp-workspace-";
const isModelTool = (name: string) => name !== "tool_search" && !name.startsWith("mcp__");

/** Register old direct tools for durable task replay, never for model discovery. */
export function createMcpExposure(mcp: McpService) {
  let registry: Registry | undefined;
  const install = async (cwd: string) => {
    if (!registry) throw new Error("Tools must bindRegistry() before installing MCP scopes");
    const catalog = await mcp.catalog(cwd);
    const extension = defineExtension({
      name: `${prefix}${createHash("sha256").update(cwd).digest("hex").slice(0, 16)}`,
      tools: [
        ...catalog
          .filter((entry) => entry.exposure === "direct" || entry.exposure === "deferred")
          .map((entry) => entry.tool),
        // Only persisted legacy scopes select this implementation. It cannot
        // add declarations; new discovery and calls use codemode exclusively.
        defineTool({
          name: "tool_search",
          description: "Replay of an admitted legacy discovery call",
          parameters: Type.Object({ query: Type.String(), limit: Type.Optional(Type.Integer()) }),
          replay: "safe",
          execute: async ({ query, limit }) => ({
            content: [
              {
                type: "text",
                text: JSON.stringify(
                  catalog
                    .filter((entry) =>
                      query
                        .toLowerCase()
                        .split(/\s+/)
                        .every((word) =>
                          `${entry.tool.name} ${entry.tool.description}`
                            .toLowerCase()
                            .includes(word),
                        ),
                    )
                    .slice(0, limit ?? 5)
                    .map(({ tool }) => ({
                      name: tool.name,
                      description: tool.description,
                      parameters: tool.parameters,
                    })),
                ),
              },
            ],
          }),
        }),
      ],
    });
    registry.install(extension);
  };
  const baseTools = (tools: readonly ToolRegistration[]) =>
    tools.filter((tool) => isModelTool(tool.name));

  return {
    bindRegistry(value: Registry) {
      registry = value;
    },
    async installScopes(cwds: readonly string[]) {
      await Promise.all([...new Set(cwds)].map(install));
    },
    async prepareAgent(
      _cwd: string,
      agent: import("@earendil-works/pi-durable").Agent,
      _ctx: Context,
    ): Promise<import("@earendil-works/pi-durable").AgentChange> {
      return {
        extensions: agent.extensions.filter((value) => !value.name.startsWith(prefix)),
        tools: baseTools(agent.tools),
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
        await install(source.cwd);
        // Prune persisted declarations before resolving the agent, including the
        // removed standalone search tool. Unknown base tools still fail normally.
        const expected = await conversation.commit(async (tx) => {
          const state = await tx.doc(AgentDoc, conversation.id);
          if (!isDeepStrictEqual(clone(state), source)) return undefined;
          const scopes = Array.isArray(state.extensions)
            ? state.extensions
            : (state.extensions?.add ?? []);
          const available = new Set(
            scopes
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
            state.tools = state.tools.filter((name) => isModelTool(name) || available.has(name));
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
          await configure(tx, conversation.id, {
            // Existing tool tasks resolve against their conversation's agent.
            // Keep selected legacy implementations for replay; the request hook
            // strips their declarations from every model request.
            extensions: agent.extensions,
            tools: agent.tools,
          });
          return true;
        }, ctx);
        if (applied) return;
      }
    },
  };
}
