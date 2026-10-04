import type {
  AuthenticationResponseJSON,
  PublicKeyCredentialCreationOptionsJSON,
  PublicKeyCredentialRequestOptionsJSON,
  RegistrationResponseJSON,
} from "@simplewebauthn/browser";
import { withBaseUrl } from "@/client/lib/base-url";
import type { AppAppearance } from "@/shared/appearance";
import type {
  AppSettingsStatus,
  BootstrapPayload,
  CronJob,
  CronRunLog,
  RunningSubagent,
  SiteDescriptor,
  ModelOption,
  McpAuthAttempt,
  McpSettingsResponse,
  McpWorkspaceStatus,
  ProviderAuthStartResponse,
  ProviderAuthStatus,
  ProviderUsage,
  SessionMessagesPage,
  SessionResourcesResponse,
  SessionState,
  WorkspaceInfo,
} from "@/shared/types";

async function request<T>(input: string, init?: RequestInit): Promise<T> {
  const response = await fetch(withBaseUrl(input), {
    credentials: "include",
    ...init,
  });

  if (!response.ok) {
    const body = (await response.json().catch(() => ({ error: response.statusText }))) as {
      error?: string;
    };
    throw new Error(body.error || response.statusText);
  }

  return (await response.json()) as T;
}

export function setSitePublic(siteId: string, isPublic: boolean): Promise<SiteDescriptor> {
  return request(`/api/sites/${encodeURIComponent(siteId)}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ public: isPublic }),
  });
}

export function getPushPublicKey(): Promise<{ publicKey: string }> {
  return request("/api/push/public-key");
}

export function savePushSubscription(subscription: PushSubscriptionJSON): Promise<{ ok: true }> {
  return request("/api/push/subscriptions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ subscription }),
  });
}

export function deletePushSubscription(endpoint: string): Promise<{ ok: true }> {
  return request("/api/push/subscriptions/delete", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ endpoint }),
  });
}

export function getBootstrap(): Promise<BootstrapPayload> {
  return request("/api/bootstrap");
}

export function getModels(): Promise<ModelOption[]> {
  return request("/api/models");
}

export function getProviderUsage(provider: string, model: string): Promise<ProviderUsage> {
  const query = new URLSearchParams({ provider, model });
  return request(`/api/provider-usage?${query}`);
}

export function getProviderAuthStatus(): Promise<ProviderAuthStatus> {
  return request("/api/provider-auth/status");
}

export function getMcpSettings(workspaceId?: string): Promise<McpSettingsResponse> {
  const query = workspaceId ? `?${new URLSearchParams({ workspaceId })}` : "";
  return request(`/api/settings/mcp${query}`);
}

export function saveMcpServer(
  name: string,
  config: McpSettingsResponse["servers"][number]["config"],
  workspaceId?: string,
): Promise<McpSettingsResponse> {
  return request(`/api/settings/mcp/${encodeURIComponent(name)}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ workspaceId, config }),
  });
}

export function removeMcpServer(name: string, workspaceId?: string): Promise<McpSettingsResponse> {
  const query = workspaceId ? `?${new URLSearchParams({ workspaceId })}` : "";
  return request(`/api/settings/mcp/${encodeURIComponent(name)}${query}`, { method: "DELETE" });
}

export function getWorkspaceMcpStatus(workspaceId: string): Promise<McpWorkspaceStatus> {
  return request(`/api/workspaces/${encodeURIComponent(workspaceId)}/mcp`);
}

export function reconnectMcpServer(workspaceId: string, name: string): Promise<McpWorkspaceStatus> {
  return request(
    `/api/workspaces/${encodeURIComponent(workspaceId)}/mcp/${encodeURIComponent(name)}/reconnect`,
    { method: "POST" },
  );
}

export function logoutMcpServer(workspaceId: string, name: string): Promise<McpWorkspaceStatus> {
  return request(
    `/api/workspaces/${encodeURIComponent(workspaceId)}/mcp/${encodeURIComponent(name)}/logout`,
    { method: "POST" },
  );
}

export function startMcpLogin(workspaceId: string, name: string): Promise<McpAuthAttempt> {
  return request(
    `/api/workspaces/${encodeURIComponent(workspaceId)}/mcp/${encodeURIComponent(name)}/login`,
    { method: "POST" },
  );
}

export function getMcpAuthAttempt(attemptId: string): Promise<McpAuthAttempt> {
  return request(`/api/mcp/auth/${encodeURIComponent(attemptId)}`);
}

export function completeMcpAuthAttempt(
  attemptId: string,
  callbackUrl: string,
): Promise<McpAuthAttempt> {
  return request(`/api/mcp/auth/${encodeURIComponent(attemptId)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ callbackUrl }),
  });
}

export function cancelMcpAuthAttempt(attemptId: string): Promise<McpAuthAttempt> {
  return request(`/api/mcp/auth/${encodeURIComponent(attemptId)}`, { method: "DELETE" });
}

export function getOpenAIAuthAttemptStatus(attemptId: string): Promise<{ completed: boolean }> {
  return request(`/api/provider-auth/openai/attempt/${encodeURIComponent(attemptId)}`);
}

export function startOpenAIProviderAuth(): Promise<ProviderAuthStartResponse> {
  return request("/api/provider-auth/openai/start", {
    method: "POST",
  });
}

export function completeOpenAIProviderAuth(
  attemptId: string,
  callbackUrl: string,
): Promise<ProviderAuthStatus> {
  return request("/api/provider-auth/openai/complete", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ attemptId, callbackUrl }),
  });
}

export function setProviderApiKey(
  providerId: "google" | "openrouter",
  apiKey: string,
): Promise<ProviderAuthStatus> {
  return request("/api/provider-auth/api-key", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ providerId, apiKey }),
  });
}

export function beginPasskeyLogin(): Promise<{
  requestId: string;
  optionsJSON: PublicKeyCredentialRequestOptionsJSON;
}> {
  return request("/api/auth/login/options", {
    method: "POST",
  });
}

export function finishPasskeyLogin(
  requestId: string,
  response: AuthenticationResponseJSON,
): Promise<{ ok: true }> {
  return request("/api/auth/login/verify", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ requestId, response }),
  });
}

export function beginPasskeyRegistration(setupCode: string): Promise<{
  requestId: string;
  optionsJSON: PublicKeyCredentialCreationOptionsJSON;
}> {
  return request("/api/auth/register/options", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ setupCode }),
  });
}

export function finishPasskeyRegistration(
  requestId: string,
  response: RegistrationResponseJSON,
): Promise<{ ok: true }> {
  return request("/api/auth/register/verify", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ requestId, response }),
  });
}

export function logout(): Promise<{ ok: true }> {
  return request("/api/logout", {
    method: "POST",
  });
}

export function listWorkspaces(): Promise<WorkspaceInfo[]> {
  return request<{ workspaces: WorkspaceInfo[] }>("/api/workspaces").then(
    (response) => response.workspaces,
  );
}

export function setDefaultModel(
  modelId: string,
  thinkingLevel: string,
): Promise<AppSettingsStatus> {
  return request("/api/settings/default-model", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ modelId, thinkingLevel }),
  });
}

export function setAppearance(appearance: AppAppearance): Promise<AppSettingsStatus> {
  return request("/api/settings/appearance", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(appearance),
  });
}

export function setBraveSearchApiKey(apiKey: string): Promise<AppSettingsStatus> {
  return request("/api/settings/brave-search", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ apiKey }),
  });
}

export function listEnvironmentVariables(): Promise<{ names: string[] }> {
  return request("/api/settings/environment");
}

export function setEnvironmentVariable(name: string, value: string): Promise<{ names: string[] }> {
  return request(`/api/settings/environment/${encodeURIComponent(name)}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ value }),
  });
}

export function removeEnvironmentVariable(name: string): Promise<{ names: string[] }> {
  return request(`/api/settings/environment/${encodeURIComponent(name)}`, { method: "DELETE" });
}

export function getBattyAgentsFile(): Promise<{ content: string }> {
  return request("/api/settings/agents");
}

export function setBattyAgentsFile(content: string): Promise<{ content: string }> {
  return request("/api/settings/agents", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ content }),
  });
}

export function listWorkspaceCronJobs(workspaceId: string): Promise<CronJob[]> {
  return request(`/api/workspaces/${encodeURIComponent(workspaceId)}/cron-jobs`);
}

export function listRunningSubagents(sessionId: string): Promise<RunningSubagent[]> {
  return request(`/api/sessions/${encodeURIComponent(sessionId)}/subagents`);
}

export function listWorkspaceCronRunLogs(workspaceId: string): Promise<CronRunLog[]> {
  return request(`/api/workspaces/${encodeURIComponent(workspaceId)}/cron-run-logs`);
}

export function getMemoryStatus(): Promise<{
  pending: number;
  totalLeaves: number;
  builtLeaves: number;
  error?: string;
}> {
  return request("/api/memory/status");
}

export function getMain(): Promise<SessionState> {
  return request("/api/main");
}
export function getMainMessages(options: {
  before?: string;
  limit?: number;
}): Promise<SessionMessagesPage> {
  const query = new URLSearchParams();
  if (options.before) query.set("before", options.before);
  if (options.limit) query.set("limit", String(options.limit));
  return request(`/api/main/messages?${query}`);
}
export function patchMain(kind: "model" | "thinking", body: object): Promise<SessionState> {
  return request(`/api/main/${kind}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}
export function submitMainPrompt(
  kind: "prompt" | "steer",
  text: string,
  files: File[],
  clientMessageId: string,
): Promise<{ disposition: "started" | "queued"; submissionId: string; sessionId: string }> {
  const body = new FormData();
  body.set("text", text);
  body.set("clientMessageId", clientMessageId);
  for (const file of files) body.append("files", file, file.name);
  return request(`/api/main/${kind}`, { method: "POST", body });
}
export function stopMain(): Promise<{ ok: true }> {
  return request("/api/main/stop", { method: "POST" });
}
export function removeMainQueuedPrompt(
  kind: "steer" | "followUp",
  index: number,
): Promise<SessionState> {
  return request("/api/main/queue/remove", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ kind, index }),
  });
}

export function getSession(sessionId: string): Promise<SessionState> {
  return request(`/api/sessions/${sessionId}`);
}

export function getSessionResources(sessionId: string): Promise<SessionResourcesResponse> {
  return request(`/api/sessions/${encodeURIComponent(sessionId)}/resources`);
}

export function getSessionMessages(
  session: Pick<SessionState, "id" | "workspaceId" | "path">,
  options: { before?: string; limit?: number } = {},
): Promise<SessionMessagesPage> {
  const params = new URLSearchParams();
  if (options.before) {
    params.set("before", options.before);
  }
  if (options.limit !== undefined) {
    params.set("limit", String(Math.floor(options.limit)));
  }

  return request(`/api/sessions/${session.id}/messages?${params.toString()}`);
}
