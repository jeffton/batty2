import type { FastifyInstance } from "fastify";
import type { AppConfig } from "../config";
import type { PasskeyAuthService } from "../passkeys";
import type { createLoginRateLimiter } from "../login-rate-limit";

export interface RouteContext {
  app: FastifyInstance;
  config: AppConfig;
  passkeys: PasskeyAuthService;
  authAttemptLimiter: ReturnType<typeof createLoginRateLimiter>;
  routePath: (route: string) => string;
}
