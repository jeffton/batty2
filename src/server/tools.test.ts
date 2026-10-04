// @vitest-environment node
import { afterEach, describe, expect, it } from "vite-plus/test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import http from "node:http";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { Type } from "typebox";
import { createModels } from "@earendil-works/pi-ai/models";
import {
  fauxProvider,
  fauxAssistantMessage,
  fauxToolCall,
  fauxText,
} from "@earendil-works/pi-ai/providers/faux";
import { createRegistry, Harness, MemoryStorage } from "@earendil-works/pi-durable";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { createOrchestration, OrchestrationDoc } from "./orchestration";
import { createTools } from "./tools";
import { persistentBashOperations } from "./durable-bash";
import { stateDirPath } from "./options";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function fixture(persistent = false) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "batty-tools-test-"));
  cleanups.push(() => fs.rm(directory, { recursive: true, force: true }));
  const config = { battyDir: directory, browserMaxTabs: 4, workspacesRoots: [directory] } as any;
  const tools = await createTools(config);
  cleanups.push(() => tools.close());
  const faux = fauxProvider({ tokensPerSecond: 100_000 });
  const models = createModels();
  models.setProvider(faux.provider);
  const registry = createRegistry();
  registry.install(tools.extension);
  tools.bindRegistry(registry);
  const settings = {
    get extensions() {
      return registry
        .snapshot()
        .installed()
        .filter((extension) => !extension.name.startsWith("batty-mcp-workspace-"));
    },
  };
  let harness = await Harness.open(
    persistent
      ? await openNodeSqliteStorage(path.join(directory, "session.sqlite"))
      : new MemoryStorage(),
    { models, registry, settings, env: () => new NodeExecutionEnv({ cwd: directory }) },
    BACKGROUND_CONTEXT,
  );
  tools.bindHarness(harness);
  cleanups.push(() => harness.close(BACKGROUND_CONTEXT));
  let main = await harness.root(BACKGROUND_CONTEXT, {
    agent: { cwd: directory, model: { provider: "faux", modelId: "faux-1" } },
  });
  const reopen = async () => {
    await harness.close(BACKGROUND_CONTEXT);
    harness = await Harness.open(
      await openNodeSqliteStorage(path.join(directory, "session.sqlite")),
      { models, registry, settings, env: () => new NodeExecutionEnv({ cwd: directory }) },
      BACKGROUND_CONTEXT,
    );
    tools.bindHarness(harness);
    main = await harness.root(BACKGROUND_CONTEXT);
    harness.resume();
    return { harness, main };
  };
  const run = async (code: string) => {
    faux.setResponses([
      fauxAssistantMessage([fauxToolCall("codemode", { code })], { stopReason: "toolUse" }),
      fauxAssistantMessage([fauxText("done")]),
    ]);
    const settled = await (
      await main.submit({ type: "input", content: "run script" }, BACKGROUND_CONTEXT)
    ).wait(BACKGROUND_CONTEXT);
    expect(settled.status).toBe("done");
    const view = await main.viewState(BACKGROUND_CONTEXT);
    const result = view.value.entries.findLast(
      (entry) =>
        entry.kind === "pi.tool-result" &&
        entry.model?.[0]?.role === "toolResult" &&
        entry.model[0].toolName === "codemode",
    )!.model![0] as any;
    view.dispose();
    return result;
  };
  const api = {
    callId: "call",
    taskId: 1,
    conversationId: 1,
    env: { cwd: directory },
    agent: async () => ({ cwd: directory, tools: tools.extension.tools }),
    output: () => {},
    details: async () => {},
    snapshot: async () => undefined,
    commit: async (fn: any) => main.commit(fn, BACKGROUND_CONTEXT),
  } as any;
  return { directory, config, tools, api, run, harness, main, registry, faux, reopen };
}

describe("durable tool bridge", () => {
  it("retains explicit read limits and executes registered tools in QuickJS with persistent store", async () => {
    const { directory, tools, api, run } = await fixture();
    await fs.writeFile(path.join(directory, "large.txt"), "x".repeat(60_000));
    const read = tools.extension.tools!.find((tool) => tool.name === "read")!;
    const result = await read.execute({ path: "large.txt", limit: 1 }, api, BACKGROUND_CONTEXT);
    expect(result.content?.[0]).toEqual({ type: "text", text: "x".repeat(60_000) });
    tools.registerTools([
      {
        name: "multiply",
        description: "multiply numbers",
        parameters: Type.Object({ value: Type.Number() }),
        execute: async ({ value }: any) => ({
          content: [{ type: "text", text: String(value * 2) }],
        }),
      },
    ]);
    const codemode = tools.extension.tools!.find((tool) => tool.name === "codemode")!;
    const script = await run('store("count", 3); return await tools.multiply({value: 4})');
    expect(script.isError).toBe(false);
    expect(script.content?.[0]).toEqual({ type: "text", text: "8" });
    const stored = await run('return load("count")');
    expect(stored.content?.[0]).toEqual({ type: "text", text: "3" });
  });

  it("calls stdio MCP tools through codemode and returns structured MCP results", async () => {
    const { directory, config, tools, api, run } = await fixture();
    const server = path.join(directory, "mcp.cjs");
    await fs.writeFile(
      server,
      `const readline=require('node:readline'); readline.createInterface({input:process.stdin}).on('line', line=>{const m=JSON.parse(line);if(m.id===undefined)return;let result={};if(m.method==='initialize')result={protocolVersion:'2025-11-25',capabilities:{tools:{}},serverInfo:{name:'test',version:'1'}};if(m.method==='tools/list')result={tools:[{name:'echo',description:'Echo input',inputSchema:{type:'object',properties:{value:{type:'string'}},required:['value']}}]};if(m.method==='tools/call')result={content:[{type:'text',text:m.params.arguments.value}],structuredContent:{value:m.params.arguments.value}};process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result})+'\\n')})`,
    );
    await fs.mkdir(stateDirPath(config.battyDir), { recursive: true });
    await fs.writeFile(
      path.join(stateDirPath(config.battyDir), "mcp.json"),
      JSON.stringify({ mcpServers: { test: { command: process.execPath, args: [server] } } }),
    );
    const codemode = tools.extension.tools!.find((tool) => tool.name === "codemode")!;
    const result = await run(
      'return (await tools.mcp__test__echo({value:"hello"})).structuredContent.value',
    );
    expect(result.isError).toBe(false);
    expect(result.content?.[0]).toEqual({ type: "text", text: "hello" });
  });

  it("offers direct MCP tools, materializes deferred declarations, and hides codemode-only/hidden declarations", async () => {
    const { directory, tools, main, faux, run, reopen } = await fixture(true);
    const server = path.join(directory, "modes.cjs");
    await fs.writeFile(
      server,
      `require('node:readline').createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line);if(m.id===undefined)return;let result={};if(m.method==='initialize')result={protocolVersion:'2025-11-25',capabilities:{tools:{}},serverInfo:{name:'test',version:'1'}};if(m.method==='tools/list')result={tools:['direct','deferred','script','hidden'].map(name=>({name,description:name,inputSchema:{type:'object',properties:{}}}))};if(m.method==='tools/call')result={content:[{type:'text',text:m.params.name}]};process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result})+'\\n')})`,
    );
    await tools.mcp.setServer(undefined, "modes", {
      command: process.execPath,
      args: [server],
      exposure: "codemode",
      toolExposure: { direct: "direct", deferred: "deferred", hidden: "hidden" },
    });
    await tools.syncConversation(main, BACKGROUND_CONTEXT);
    const names = () =>
      main.agent(BACKGROUND_CONTEXT).then((agent) => agent.tools.map((tool) => tool.name));
    expect(await names()).toContain("mcp__modes__direct");
    expect(await names()).not.toContain("mcp__modes__deferred");
    expect(await names()).not.toContain("mcp__modes__script");
    expect(await names()).not.toContain("mcp__modes__hidden");
    const declared = (request: any) => {
      const names = new Set<string>();
      for (const message of request.messages)
        if (message.role === "system") {
          for (const tool of message.toolsAdded ?? []) names.add(tool.name);
          for (const name of message.toolsRemoved ?? []) names.delete(name);
        }
      return [...names];
    };
    faux.setResponses([
      (request) => {
        expect(declared(request)).toContain("mcp__modes__direct");
        expect(declared(request)).not.toContain("mcp__modes__deferred");
        expect(declared(request)).not.toContain("mcp__modes__script");
        expect(declared(request)).not.toContain("mcp__modes__hidden");
        return fauxAssistantMessage([fauxToolCall("mcp__modes__direct", {})], {
          stopReason: "toolUse",
        });
      },
      fauxAssistantMessage([fauxToolCall("tool_search", { query: "deferred" })], {
        stopReason: "toolUse",
      }),
      (request) => {
        expect(declared(request)).toContain("mcp__modes__deferred");
        return fauxAssistantMessage([fauxToolCall("mcp__modes__deferred", {})], {
          stopReason: "toolUse",
        });
      },
      fauxAssistantMessage([fauxText("done")]),
    ]);
    expect(
      (
        await (
          await main.submit({ type: "input", content: "find deferred" }, BACKGROUND_CONTEXT)
        ).wait(BACKGROUND_CONTEXT)
      ).status,
    ).toBe("done");
    expect(await names()).toContain("mcp__modes__deferred");
    const view = await main.viewState(BACKGROUND_CONTEXT);
    const called = view.value.entries
      .flatMap((entry) => entry.model ?? [])
      .filter(
        (message) => message.role === "toolResult" && message.toolName.startsWith("mcp__modes__"),
      );
    expect(called).toHaveLength(2);
    expect(called.every((message: any) => message.isError === false)).toBe(true);
    view.dispose();
    const discovered = await run(
      'return ALL_TOOLS.filter(tool=>tool.name.startsWith("mcp__modes__")).map(tool=>tool.name).sort()',
    );
    expect(discovered.content[0].text).toContain("mcp__modes__script");
    expect(discovered.content[0].text).not.toContain("mcp__modes__hidden");
    const restored = await reopen();
    await tools.syncConversation(restored.main, BACKGROUND_CONTEXT);
    expect(
      (await restored.main.agent(BACKGROUND_CONTEXT)).tools.map((tool) => tool.name),
    ).toContain("mcp__modes__deferred");
    const otherCwd = path.join(directory, "other");
    await fs.mkdir(otherCwd);
    const prepared = await tools.prepareAgent(
      otherCwd,
      await restored.main.agent(BACKGROUND_CONTEXT),
      BACKGROUND_CONTEXT,
    );
    expect(prepared.tools).toContainEqual(expect.objectContaining({ name: "mcp__modes__direct" }));
    expect(prepared.tools).not.toContainEqual(
      expect.objectContaining({ name: "mcp__modes__deferred" }),
    );
    await tools.mcp.setServer(undefined, "modes", {
      command: process.execPath,
      args: [server],
      exposure: "codemode",
      toolExposure: { direct: "hidden", deferred: "codemode", hidden: "hidden" },
    });
    await tools.syncConversation(restored.main, BACKGROUND_CONTEXT);
    expect(
      (await restored.main.agent(BACKGROUND_CONTEXT)).tools
        .map((tool) => tool.name)
        .filter((name) => name.startsWith("mcp__")),
    ).toEqual([]);
  });

  it("calls Streamable HTTP MCP and interrupts a spinning QuickJS script", async () => {
    const { tools, api, run } = await fixture();
    const server = http.createServer(async (request, response) => {
      if (request.method !== "POST") {
        response.writeHead(405).end();
        return;
      }
      let body = "";
      for await (const chunk of request) body += chunk;
      const message = JSON.parse(body);
      if (message.id === undefined) {
        response.writeHead(202).end();
        return;
      }
      let result: any = {};
      if (message.method === "initialize")
        result = {
          protocolVersion: "2025-11-25",
          capabilities: { tools: {} },
          serverInfo: { name: "http-test", version: "1" },
        };
      if (message.method === "tools/list")
        result = { tools: [{ name: "answer", inputSchema: { type: "object", properties: {} } }] };
      if (message.method === "tools/call") result = { content: [{ type: "text", text: "42" }] };
      response
        .writeHead(200, { "Content-Type": "application/json" })
        .end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }));
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    cleanups.push(async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    });
    const address = server.address() as { port: number };
    await tools.mcp.setServer(undefined, "http", {
      url: `http://127.0.0.1:${address.port}/mcp`,
      headers: { Authorization: "Bearer test" },
    });
    const codemode = tools.extension.tools!.find((tool) => tool.name === "codemode")!;
    const result = await run("return (await tools.mcp__http__answer({})).content[0].text");
    expect(result.isError).toBe(false);
    expect(result.content?.[0]).toEqual({ type: "text", text: "42" });
    const spinning = await run('// @options: {"timeout_ms": 50}\nwhile (true) {}');
    expect(spinning.isError).toBe(true);
  });

  it("stops a worker's detached native bash after an explicit subagent stop", async () => {
    const { directory, tools, harness, main, registry, faux } = await fixture();
    const orchestration = createOrchestration({
      workspaces: [
        {
          id: "test",
          path: directory,
          label: "test",
          kind: "workspace",
          isPinned: false,
          isAssistant: false,
        },
      ],
    });
    registry.install(orchestration.extension);
    tools.registerTools(orchestration.extension.tools!);
    await orchestration.bind(harness, main);
    cleanups.push(async () => {
      orchestration.close();
    });
    let workerId = "";
    faux.setResponses(
      Array.from({ length: 20 }, () => (request) => {
        const last = request.messages.findLast((message) => message.role !== "system");
        if (last?.role === "user" && last.content === "launch worker")
          return fauxAssistantMessage(
            [fauxToolCall("subagent", { action: "run", async: true, prompt: "worker shell" })],
            { stopReason: "toolUse" },
          );
        if (last?.role === "user" && last.content === "worker shell")
          return fauxAssistantMessage(
            [
              fauxToolCall("bash", {
                command: "echo started > worker-started; sleep 1; echo survived > worker-marker",
              }),
            ],
            { stopReason: "toolUse" },
          );
        if (last?.role === "user" && last.content === "stop worker")
          return fauxAssistantMessage(
            [fauxToolCall("subagent", { action: "stop", sessionId: workerId })],
            { stopReason: "toolUse" },
          );
        return fauxAssistantMessage([fauxText("done")]);
      }),
    );
    await (
      await main.submit({ type: "input", content: "launch worker" }, BACKGROUND_CONTEXT)
    ).wait(BACKGROUND_CONTEXT);
    for (let attempt = 0; attempt < 200; attempt++) {
      try {
        await fs.access(path.join(directory, "worker-started"));
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      await delay(10);
    }
    await fs.access(path.join(directory, "worker-started"));
    workerId = Object.keys(
      (await harness.snapshot(OrchestrationDoc, BACKGROUND_CONTEXT))!.workers,
    )[0]!;
    await (
      await main.submit({ type: "input", content: "stop worker" }, BACKGROUND_CONTEXT)
    ).wait(BACKGROUND_CONTEXT);
    await delay(1200);
    await expect(fs.access(path.join(directory, "worker-marker"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  }, 15_000);

  it("gives two subagent calls distinct durable identities and exposes their details", async () => {
    const { directory, tools, harness, main, registry, faux } = await fixture();
    const orchestration = createOrchestration({
      workspaces: [
        {
          id: "test",
          path: directory,
          label: "test",
          kind: "workspace",
          isPinned: false,
          isAssistant: false,
        },
      ],
    });
    registry.install(orchestration.extension);
    tools.registerTools(orchestration.extension.tools!);
    await orchestration.bind(harness, main);
    cleanups.push(async () => {
      orchestration.close();
    });
    const code =
      'return await Promise.all([tools.subagent({action:"run",async:true,prompt:"first worker"}), tools.subagent({action:"run",async:true,prompt:"second worker"})])';
    faux.setResponses(
      Array.from({ length: 15 }, () => (request) => {
        const last = request.messages.findLast((message) => message.role !== "system");
        return last?.role === "user" && last.content === "launch"
          ? fauxAssistantMessage([fauxToolCall("codemode", { code })], { stopReason: "toolUse" })
          : fauxAssistantMessage([fauxText("done")]);
      }),
    );
    await (
      await main.submit({ type: "input", content: "launch" }, BACKGROUND_CONTEXT)
    ).wait(BACKGROUND_CONTEXT);
    const state = (await harness.snapshot(OrchestrationDoc, BACKGROUND_CONTEXT))!;
    expect(Object.keys(state.workers)).toHaveLength(2);
    expect(Object.keys(state.calls)).toHaveLength(2);
    const view = await main.viewState(BACKGROUND_CONTEXT);
    const result = view.value.entries.find(
      (entry) =>
        entry.kind === "pi.tool-result" &&
        entry.model?.[0]?.role === "toolResult" &&
        entry.model[0].toolName === "codemode",
    )!.model![0] as any;
    expect(result.isError).toBe(false);
    expect(result.details.calls.map((call: any) => call.subagent.prompt).sort()).toEqual([
      "first worker",
      "second worker",
    ]);
    view.dispose();
  });

  it("replays a script's read->bash journal after SQLite reopen without repeating the shell effect", async () => {
    const { directory, tools, harness, main, faux, reopen } = await fixture(true);
    await fs.writeFile(path.join(directory, "seed"), "original");
    const code =
      'const source=await tools.read({path:"seed"}); const bash=await tools.bash({command:"echo run >> count; sleep 1; echo finished"}); return source+":"+bash.output;';
    faux.setResponses([
      fauxAssistantMessage([fauxToolCall("codemode", { code })], { stopReason: "toolUse" }),
      fauxAssistantMessage([fauxText("done")]),
    ]);
    const submission = await main.submit(
      { type: "input", content: "run script" },
      BACKGROUND_CONTEXT,
    );
    harness.resume();
    for (let attempt = 0; attempt < 200; attempt++) {
      try {
        await fs.access(path.join(directory, "count"));
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      await delay(10);
    }
    expect(await fs.readFile(path.join(directory, "count"), "utf8")).toBe("run\n");
    await fs.writeFile(path.join(directory, "seed"), "changed");
    const restarted = await reopen();
    const recovered = await restarted.harness.submission(submission.id, BACKGROUND_CONTEXT);
    expect((await recovered!.wait(BACKGROUND_CONTEXT)).status).toBe("done");
    expect(await fs.readFile(path.join(directory, "count"), "utf8")).toBe("run\n");
    const view = await restarted.main.viewState(BACKGROUND_CONTEXT);
    const result = view.value.entries.findLast(
      (entry) =>
        entry.kind === "pi.tool-result" &&
        entry.model?.[0]?.role === "toolResult" &&
        entry.model[0].toolName === "codemode",
    )!.model![0] as any;
    expect(result.isError).toBe(false);
    expect(result.content[0].text).toContain("original:finished");
    view.dispose();
  }, 15_000);

  it("reconnects a running bash job after its service process is killed without executing it twice", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "batty-bash-test-"));
    cleanups.push(() => fs.rm(directory, { recursive: true, force: true }));
    const waiter = path.join(directory, "waiter.mjs");
    const module = pathToFileURL(path.join(process.cwd(), "src/server/durable-bash.ts")).href;
    await fs.writeFile(
      waiter,
      `import {persistentBashOperations} from ${JSON.stringify(module)}; await persistentBashOperations(${JSON.stringify(directory)},'job').exec('echo run >> count; sleep 1; echo finished',${JSON.stringify(directory)},{onData:()=>{}});`,
    );
    const child = spawn(
      process.execPath,
      [
        "--import",
        pathToFileURL(createRequire(path.join(process.cwd(), "package.json")).resolve("tsx")).href,
        waiter,
      ],
      { cwd: process.cwd(), stdio: ["ignore", "ignore", "pipe"] },
    );
    let stderr = "";
    child.stderr.on("data", (data) => {
      stderr += data.toString();
    });
    const exited = once(child, "exit");
    for (let attempts = 0; attempts < 100; attempts++) {
      try {
        if ((await fs.readFile(path.join(directory, "count"), "utf8")).includes("run")) break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      await delay(20);
    }
    expect(stderr).toBe("");
    expect(await fs.readFile(path.join(directory, "count"), "utf8")).toBe("run\n");
    child.kill("SIGKILL");
    await exited;
    let output = "";
    const result = await persistentBashOperations(directory, "job").exec(
      "echo duplicated >> count",
      directory,
      {
        onData: (data) => {
          output += data.toString();
        },
      },
    );
    expect(result.exitCode).toBe(0);
    expect(output).toContain("finished");
    expect(await fs.readFile(path.join(directory, "count"), "utf8")).toBe("run\n");
  }, 15_000);
});
