import type { FastifyInstance } from "fastify";
import type { createMemory } from "../memory";

export function registerMemoryTreeRoutes(
  app: FastifyInstance,
  memory: Pick<ReturnType<typeof createMemory>, "browserOverview" | "browserNode">,
) {
  // These routes also sit behind the application's API authentication hook.
  app.addHook("onRequest", async (request, reply) => {
    if (request.url.split("?", 1)[0]?.startsWith("/api/memory/tree")) {
      reply.header("Cache-Control", "no-store");
      if (!request.auth) return reply.code(401).send({ error: "Authentication required" });
    }
  });
  app.get("/api/memory/tree", async () => memory.browserOverview());
  app.get<{ Params: { id: string; count: string } }>(
    "/api/memory/tree/:id/:count",
    async (request, reply) => {
      const { id, count } = request.params;
      if (!/^\d+$/.test(id) || !/^\d+$/.test(count))
        return reply.code(400).send({ error: "Invalid memory range" });
      try {
        return await memory.browserNode(Number(id), Number(count));
      } catch (error) {
        if (error instanceof RangeError) return reply.code(400).send({ error: error.message });
        throw error;
      }
    },
  );
}
