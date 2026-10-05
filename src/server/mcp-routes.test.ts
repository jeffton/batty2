// @vitest-environment node
import { expect, it } from "vite-plus/test";
import Fastify from "fastify";
import { registerMcpRoutes } from "./routes/mcp";

it("serves global MCP routes and rejects scoped requests without mutating settings", async () => {
  const app = Fastify();
  const writes: unknown[] = [];
  const mcp = {
    readSettings: () => ({ servers: [], errors: [] }),
    getStatus: () => ({ servers: [], errors: [] }),
    setServer: (...args: unknown[]) => {
      writes.push(args);
      return {};
    },
    removeServer: (...args: unknown[]) => {
      writes.push(args);
      return {};
    },
    reconnect: (name: string) => ({ name }),
    logout: (name: string) => ({ name }),
    startAuth: (name: string) => ({ serverName: name }),
  };
  registerMcpRoutes({ app, mcp, routePath: (path: string) => path } as any);
  try {
    expect((await app.inject("/api/mcp")).statusCode).toBe(200);
    for (const workspace of ["one", "two"]) {
      expect((await app.inject(`/api/workspaces/${workspace}/mcp`)).statusCode).toBe(404);
      expect(
        (
          await app.inject({
            method: "POST",
            url: `/api/workspaces/${workspace}/mcp/test/reconnect`,
          })
        ).statusCode,
      ).toBe(404);
      expect((await app.inject(`/api/settings/mcp?workspaceId=${workspace}`)).statusCode).toBe(400);
      expect(
        (
          await app.inject({
            method: "PUT",
            url: "/api/settings/mcp/test",
            payload: { workspaceId: workspace, config: { command: "test" } },
          })
        ).statusCode,
      ).toBe(400);
      expect(
        (
          await app.inject({
            method: "DELETE",
            url: `/api/settings/mcp/test?workspaceId=${workspace}`,
          })
        ).statusCode,
      ).toBe(400);
    }
    expect(writes).toEqual([]);
    expect(
      (
        await app.inject({
          method: "PUT",
          url: "/api/settings/mcp/test",
          payload: { config: { command: "test" } },
        })
      ).statusCode,
    ).toBe(200);
    expect(writes).toEqual([["test", { command: "test" }]]);
    expect((await app.inject({ method: "POST", url: "/api/mcp/test/reconnect" })).json()).toEqual({
      name: "test",
    });
  } finally {
    await app.close();
  }
});
