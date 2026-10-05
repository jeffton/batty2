import type { McpServerConfig } from "@/shared/types";
import type { RouteContext } from "./context";
import type { McpService } from "../mcp-service";

const SERVER_NAME = /^[A-Za-z0-9_-]+$/;

export function registerMcpRoutes(context: RouteContext & { mcp: McpService }): void {
  const { app, mcp, routePath } = context;

  // Reject scoped writes rather than accidentally changing global settings.
  app.get<{ Querystring: Record<string, unknown> }>(
    routePath("/api/settings/mcp"),
    (request, reply) => {
      if (Object.keys(request.query).length)
        return reply.code(400).send({ error: "MCP settings are global" });
      return mcp.readSettings();
    },
  );

  app.put<{
    Params: { name: string };
    Body: { config?: unknown };
    Querystring: Record<string, unknown>;
  }>(routePath("/api/settings/mcp/:name"), async (request, reply) => {
    const { name } = request.params;
    if (!SERVER_NAME.test(name)) return reply.code(400).send({ error: "Invalid MCP server name" });
    if (
      Object.keys(request.query).length ||
      Object.keys(request.body ?? {}).some((key) => key !== "config")
    )
      return reply.code(400).send({ error: "MCP settings are global" });
    const serverConfig = request.body?.config;
    if (!serverConfig || typeof serverConfig !== "object" || Array.isArray(serverConfig))
      return reply.code(400).send({ error: "MCP server config must be an object" });
    return mcp.setServer(name, serverConfig as McpServerConfig);
  });

  app.delete<{ Params: { name: string }; Querystring: Record<string, unknown> }>(
    routePath("/api/settings/mcp/:name"),
    async (request, reply) => {
      if (Object.keys(request.query).length)
        return reply.code(400).send({ error: "MCP settings are global" });
      const { name } = request.params;
      if (!SERVER_NAME.test(name))
        return reply.code(400).send({ error: "Invalid MCP server name" });
      return mcp.removeServer(name);
    },
  );

  app.get(routePath("/api/mcp"), () => mcp.getStatus());
  for (const action of ["reconnect", "logout", "login"] as const) {
    app.post<{ Params: { name: string } }>(
      routePath(`/api/mcp/:name/${action}`),
      (request, reply) => {
        const { name } = request.params;
        if (!SERVER_NAME.test(name))
          return reply.code(400).send({ error: "Invalid MCP server name" });
        return action === "login" ? mcp.startAuth(name) : mcp[action](name);
      },
    );
  }

  app.get<{ Params: { attemptId: string } }>(routePath("/api/mcp/auth/:attemptId"), (request) =>
    mcp.getAuthAttempt(request.params.attemptId),
  );
  app.post<{ Params: { attemptId: string }; Body: { callbackUrl?: unknown } }>(
    routePath("/api/mcp/auth/:attemptId"),
    async (request, reply) => {
      if (typeof request.body?.callbackUrl !== "string" || !request.body.callbackUrl)
        return reply.code(400).send({ error: "callbackUrl must be a non-empty string" });
      return mcp.completeAuth(request.params.attemptId, request.body.callbackUrl);
    },
  );
  app.delete<{ Params: { attemptId: string } }>(routePath("/api/mcp/auth/:attemptId"), (request) =>
    mcp.cancelAuth(request.params.attemptId),
  );
}
