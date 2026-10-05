import { defineStore } from "pinia";
import { blockAppReload, checkAppUpdate } from "@/client/lib/app-updates";
import { primeAgentNotifications } from "@/client/lib/agent-notifications";
import { syncPushSubscription, unregisterPushSubscription } from "@/client/lib/push-notifications";
import { withBaseUrl } from "@/client/lib/base-url";
import { applyAppAppearance } from "@/client/lib/appearance";
import * as api from "@/client/lib/api";
import { applyServerEvent, applySessionResponse } from "@/client/lib/session-events";
import { mergeSessionState } from "@/client/lib/session-state";
import { createAppState } from "./app-state";
import { providerSettingsActions } from "./app-provider-settings";
import type { ServerEvent } from "@/shared/types";
let source: EventSource | undefined;
let watchdog: ReturnType<typeof setInterval> | undefined;
let lastActivity = 0;
let uploads = 0;
blockAppReload(() => uploads > 0);
export const useAppStore = defineStore("app", {
  state: createAppState,
  actions: {
    ...providerSettingsActions,
    async bootstrap() {
      try {
        const payload = await api.getBootstrap();
        this.authenticated = payload.authenticated;
        this.bootstrapped = true;
        this.auth = payload.auth;
        this.providerAuth = payload.providerAuth;
        this.settings = payload.settings;
        this.models = payload.models;
        applyAppAppearance(this.settings.appearance);
        if (this.authenticated) {
          this.workspaces = await api.listWorkspaces();
          this.activeSession = mergeSessionState(await api.getMain(), this.activeSession);
          this.openStream();
          void syncPushSubscription(false).catch((error) => {
            this.lastError = error instanceof Error ? error.message : String(error);
          });
        } else {
          this.closeStream();
          this.activeSession = undefined;
        }
        this.bootstrapFailed = false;
        this.lastError = undefined;
      } catch (error) {
        this.bootstrapFailed = true;
        this.lastError = error instanceof Error ? error.message : String(error);
        this.connectionState = "offline";
      }
    },
    async recoverConnection() {
      if (this.bootstrapFailed || !this.bootstrapped || !this.activeSession) await this.bootstrap();
      else if (this.authenticated) this.openStream();
    },
    openStream() {
      this.closeStream();
      this.connectionState = "connecting";
      const current = new EventSource(withBaseUrl("/api/main/events"));
      source = current;
      lastActivity = Date.now();
      const touch = () => {
        if (source === current) lastActivity = Date.now();
      };
      current.addEventListener("heartbeat", touch);
      watchdog = setInterval(() => {
        if (document.visibilityState === "hidden") return;
        if (Date.now() - lastActivity > 65_000) this.openStream();
        void checkAppUpdate().catch((error) => {
          this.lastError = String(error);
        });
      }, 15_000);
      current.onopen = () => {
        if (source !== current) return;
        touch();
        this.connectionState = "online";
        void checkAppUpdate().catch((error) => {
          this.lastError = String(error);
        });
      };
      current.onerror = () => {
        if (source !== current) return;
        this.connectionState = navigator.onLine ? "connecting" : "offline";
      };
      current.onmessage = (message) => {
        if (source !== current) return;
        touch();
        const event = JSON.parse(message.data) as ServerEvent;
        if (event.type === "error") this.lastError = event.message;
        this.activeSession = applyServerEvent(this.activeSession, event);
      };
    },
    closeStream() {
      clearInterval(watchdog);
      watchdog = undefined;
      source?.close();
      source = undefined;
    },
    async logout() {
      await unregisterPushSubscription();
      await api.logout();
      this.closeStream();
      this.authenticated = false;
      this.activeSession = undefined;
    },
    setAuthError(error: unknown) {
      this.authError = error instanceof Error ? error.message : String(error);
    },
    primeNotifications() {
      void primeAgentNotifications()
        .then((granted) => {
          if (granted) return syncPushSubscription(false);
        })
        .catch((error) => {
          this.lastError = error instanceof Error ? error.message : String(error);
        });
    },
    async sendPrompt(text: string, files: File[], clientMessageId: string) {
      this.primeNotifications();
      uploads += 1;
      try {
        return await api.submitMainPrompt("prompt", text, files, clientMessageId);
      } finally {
        uploads -= 1;
      }
    },
    async steerPrompt(text: string, files: File[], clientMessageId: string) {
      this.primeNotifications();
      uploads += 1;
      try {
        return await api.submitMainPrompt("steer", text, files, clientMessageId);
      } finally {
        uploads -= 1;
      }
    },
    async stopActiveSession() {
      await api.stopMain();
    },
    async setModel(model: string) {
      const streamId = this.activeSession?.streamId;
      const response = await api.patchMain("model", { model });
      this.activeSession = applySessionResponse(this.activeSession, response, streamId);
    },
    async setThinkingLevel(thinkingLevel: string) {
      const streamId = this.activeSession?.streamId;
      const response = await api.patchMain("thinking", { thinkingLevel });
      this.activeSession = applySessionResponse(this.activeSession, response, streamId);
    },
    async removeQueuedPrompt(kind: "steer" | "followUp", index: number) {
      const streamId = this.activeSession?.streamId;
      const response = await api.removeMainQueuedPrompt(kind, index);
      this.activeSession = applySessionResponse(this.activeSession, response, streamId);
    },
    async loadOlderMessages() {
      const current = this.activeSession;
      if (!current?.hasMoreMessages || this.loadingOlderMessages) return;
      this.loadingOlderMessages = true;
      try {
        const page = await api.getMainMessages({ before: current.messages[0]?.id, limit: 50 });
        const latest = this.activeSession!;
        const ids = new Set(latest.messages.map((message) => message.id));
        this.activeSession = {
          ...latest,
          messages: [
            ...page.messages.filter((message) => !ids.has(message.id)),
            ...latest.messages,
          ],
          hasMoreMessages: page.hasMoreMessages,
          totalMessageCount: page.totalMessageCount,
        };
      } catch (error) {
        this.lastError = error instanceof Error ? error.message : String(error);
      } finally {
        this.loadingOlderMessages = false;
      }
    },
  },
});
