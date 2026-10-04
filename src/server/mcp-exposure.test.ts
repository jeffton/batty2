// @vitest-environment node
import { expect, test } from "vite-plus/test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import {
  AgentDoc,
  createRegistry,
  defineExtension,
  defineTool,
  Harness,
  MemoryStorage,
  type ToolRegistration,
} from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { Type } from "typebox";
import { createMcpExposure } from "./mcp-exposure";
import type { McpService } from "./mcp-service";

const tool = (name: string) =>
  defineTool({
    name,
    description: name,
    parameters: Type.Object({}),
    execute: async () => ({ content: [{ type: "text", text: name }] }),
  });
const models = () => {
  const models = createModels();
  models.setProvider(fauxProvider().provider);
  return models;
};

test("MCP sync retries a delayed inline catalogue when the canonical agent is restored", async () => {
  const base = defineExtension({ name: "base", tools: [tool("base")] });
  const registry = createRegistry();
  registry.install(base);
  let release!: () => void;
  let started!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const entered = new Promise<void>((resolve) => {
    started = resolve;
  });
  const catalogues: string[] = [];
  const exposure = createMcpExposure({
    catalog: async (cwd: string) => {
      catalogues.push(cwd);
      if (cwd === "/inline") {
        started();
        await gate;
      }
      return [
        {
          tool: tool(cwd === "/inline" ? "mcp__inline__read" : "mcp__canonical__read"),
          exposure: "direct" as const,
        },
      ];
    },
  } as unknown as McpService);
  exposure.bindRegistry(registry);
  const harness = await Harness.open(
    new MemoryStorage(),
    { models: models(), registry, settings: { extensions: [base] } },
    ctx,
  );
  try {
    const main = await harness.root(ctx, {
      agent: {
        cwd: "/canonical",
        model: { provider: "faux", modelId: "faux-1" },
        thinkingLevel: "off",
      },
    });
    await exposure.syncConversation(main, ctx);
    const canonical = await main.agent(ctx);
    await main.configure(
      { cwd: "/inline", extensions: [base], tools: base.tools, thinkingLevel: "high" },
      ctx,
    );
    const pending = exposure.syncConversation(main, ctx);
    await entered;
    await main.configure(
      {
        cwd: "/canonical",
        extensions: canonical.extensions,
        tools: canonical.tools,
        model: canonical.model,
        thinkingLevel: "off",
      },
      ctx,
    );
    release();
    await pending;
    const final = await main.agent(ctx);
    expect(final.cwd).toBe("/canonical");
    expect(final.thinkingLevel).toBe("off");
    expect(final.tools.map((tool) => tool.name)).toEqual(["base"]);
    expect(catalogues).toEqual(["/canonical", "/inline", "/canonical"]);
  } finally {
    release();
    await harness.close(ctx);
  }
});

test("MCP sync prunes deleted persisted MCP tool names before resolving a reopened agent", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "batty-mcp-prune-"));
  const database = path.join(root, "session.sqlite");
  const base = defineExtension({ name: "base", tools: [tool("base")] });
  let registry = createRegistry();
  registry.install(base);
  const oldTool = tool("mcp__removed__read");
  let exposure = createMcpExposure({
    catalog: async () => [{ tool: oldTool, exposure: "direct" }],
  } as unknown as McpService);
  exposure.bindRegistry(registry);
  let harness = await Harness.open(
    await openNodeSqliteStorage(database),
    { models: models(), registry, settings: { extensions: [base] } },
    ctx,
  );
  try {
    let main = await harness.root(ctx, {
      agent: { cwd: root, model: { provider: "faux", modelId: "faux-1" } },
    });
    await exposure.syncConversation(main, ctx);
    const legacy = registry
      .snapshot()
      .installed()
      .find((extension) => extension.name.startsWith("batty-mcp-workspace-"))!;
    await main.configure({ extensions: [base, legacy], tools: [base.tools![0]!, oldTool] }, ctx);
    expect((await main.agent(ctx)).tools.map((tool) => tool.name)).toContain(oldTool.name);
    await harness.close(ctx);
    registry = createRegistry();
    registry.install(base);
    exposure = createMcpExposure({ catalog: async () => [] } as unknown as McpService);
    exposure.bindRegistry(registry);
    harness = await Harness.open(
      await openNodeSqliteStorage(database),
      { models: models(), registry, settings: { extensions: [base] } },
      ctx,
    );
    main = await harness.root(ctx);
    await exposure.installScopes([root]);
    expect((await harness.snapshot(AgentDoc, main.id, ctx))!.tools).toContain(oldTool.name);
    await exposure.syncConversation(main, ctx);
    expect((await main.agent(ctx)).tools.map((tool) => tool.name)).toEqual(["base"]);
    expect((await harness.snapshot(AgentDoc, main.id, ctx))!.tools).toEqual(["base"]);
    expect(
      registry
        .snapshot()
        .tools()
        .map(({ tool }) => tool.name),
    ).not.toContain(oldTool.name);
  } finally {
    await harness.close(ctx);
    await fs.rm(root, { recursive: true, force: true });
  }
});
