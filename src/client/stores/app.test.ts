import { beforeEach, afterEach, describe, expect, it, vi } from "vite-plus/test";
import { createPinia, setActivePinia } from "pinia";
import { flushPromises, mount } from "@vue/test-utils";
import { defineComponent } from "vue";
import * as api from "@/client/lib/api";
import App from "@/client/App.vue";
import ChatHeader from "@/client/components/ChatHeader.vue";
import ChatSessionPane from "@/client/components/ChatSessionPane.vue";
import { useAppStore } from "./app";
import type { BootstrapPayload, SessionState } from "@/shared/types";

const { replace } = vi.hoisted(() => ({ replace: vi.fn() }));
vi.mock("vue-router", () => ({ useRouter: () => ({ replace }) }));
vi.mock("@/client/lib/appearance", () => ({ applyAppAppearance: vi.fn() }));
vi.mock("@/client/lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/client/lib/api")>()),
  getBootstrap: vi.fn(),
  getMain: vi.fn(),
  listWorkspaces: vi.fn(),
  patchMain: vi.fn(),
  removeMainQueuedPrompt: vi.fn(),
  logout: vi.fn(),
  submitMainPrompt: vi.fn(),
  listRunningSubagents: vi.fn(),
  getMemoryStatus: vi.fn(),
}));

function state(revision = 1, streamId = "generation-a"): SessionState {
  return {
    id: "main",
    sessionId: "main",
    workspaceId: "main",
    cwd: "/",
    model: "model-original",
    thinkingLevel: "medium",
    availableThinkingLevels: ["medium"],
    isStreaming: false,
    pendingMessageCount: 0,
    queuedPrompts: [],
    updatedAt: 1,
    contextTokens: null,
    contextWindow: null,
    contextPercent: null,
    totalMessageCount: 0,
    hasMoreMessages: false,
    messagesDetailLevel: "full",
    messages: [],
    activeTools: [],
    revision,
    streamId,
  };
}
const bootstrap = {
  authenticated: true,
  auth: {},
  providerAuth: { providers: [] },
  settings: { braveSearchConfigured: false, appearance: { title: "Batty", color: "neutral" } },
  models: [],
} as unknown as BootstrapPayload;
let pinia: ReturnType<typeof createPinia>;
let wrapper: ReturnType<typeof mount> | undefined;
beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  pinia = createPinia();
  setActivePinia(pinia);
  vi.stubGlobal(
    "EventSource",
    class {
      close() {}
    },
  );
  vi.mocked(api.getBootstrap).mockResolvedValue(bootstrap);
  vi.mocked(api.getMain).mockResolvedValue(state());
  vi.mocked(api.listWorkspaces).mockResolvedValue([]);
  vi.mocked(api.listRunningSubagents).mockResolvedValue([]);
  vi.mocked(api.logout).mockResolvedValue({ ok: true });
});
afterEach(() => {
  wrapper?.unmount();
  wrapper = undefined;
  useAppStore().closeStream();
  vi.unstubAllGlobals();
});

const mutations = ["model", "thinking", "queue"] as const;
function mutate(kind: (typeof mutations)[number]) {
  const store = useAppStore();
  return kind === "model"
    ? store.setModel("model-new")
    : kind === "thinking"
      ? store.setThinkingLevel("high")
      : store.removeQueuedPrompt("followUp", 0);
}
function deferResponse(kind: (typeof mutations)[number]) {
  let resolve!: (state: SessionState) => void;
  const promise = new Promise<SessionState>((done) => {
    resolve = done;
  });
  if (kind === "queue") vi.mocked(api.removeMainQueuedPrompt).mockReturnValueOnce(promise);
  else vi.mocked(api.patchMain).mockReturnValueOnce(promise);
  return resolve;
}
describe("main mutation snapshots", () => {
  it.each(mutations)(
    "does not apply a stale %s HTTP response after SSE progressed",
    async (kind) => {
      const store = useAppStore();
      store.activeSession = state(5);
      const resolve = deferResponse(kind);
      const work = mutate(kind);
      store.activeSession = { ...state(8), model: "model-live" };
      resolve({ ...state(6), model: "model-stale" });
      await work;
      expect(store.activeSession?.revision).toBe(8);
      expect(store.activeSession?.model).toBe("model-live");
    },
  );
  it.each(mutations)(
    "rejects a %s response from a replaced stream even with a larger revision",
    async (kind) => {
      const store = useAppStore();
      store.activeSession = state(5);
      const resolve = deferResponse(kind);
      const work = mutate(kind);
      store.activeSession = state(1, "generation-b");
      resolve(state(99));
      await work;
      expect(store.activeSession?.streamId).toBe("generation-b");
      expect(store.activeSession?.revision).toBe(1);
    },
  );
  it("accepts an equal-revision authoritative response in the current stream", async () => {
    const store = useAppStore();
    store.activeSession = state(5);
    vi.mocked(api.patchMain).mockResolvedValueOnce({ ...state(5), model: "chosen" });
    await store.setModel("chosen");
    expect(store.activeSession?.model).toBe("chosen");
  });
});

describe("authentication recovery", () => {
  it("retries an initial bootstrap transport failure on the browser online event", async () => {
    vi.mocked(api.getBootstrap).mockRejectedValueOnce(new TypeError("Network unavailable"));
    wrapper = mount(App, { global: { plugins: [pinia], stubs: { RouterView: true } } });
    await flushPromises();
    const store = useAppStore();
    expect(store.bootstrapped).toBe(false);
    expect(store.bootstrapFailed).toBe(true);
    expect(wrapper.text()).toContain("Network unavailable");
    expect(replace).not.toHaveBeenCalled();
    window.dispatchEvent(new Event("online"));
    await flushPromises();
    expect(api.getBootstrap).toHaveBeenCalledTimes(2);
    expect(store.authenticated).toBe(true);
    expect(store.bootstrapFailed).toBe(false);
    expect(replace).toHaveBeenLastCalledWith("/");
  });
  it("retains authenticated state during a bootstrap transport failure", async () => {
    const store = useAppStore();
    store.authenticated = true;
    store.bootstrapped = true;
    store.activeSession = state();
    vi.mocked(api.getBootstrap).mockRejectedValueOnce(new TypeError("Disconnected"));
    await store.bootstrap();
    expect(store.authenticated).toBe(true);
    expect(store.activeSession?.id).toBe("main");
  });
  it("handles the SettingsPopover logout event", async () => {
    const store = useAppStore();
    store.authenticated = true;
    store.activeSession = state();
    wrapper = mount(ChatHeader, {
      global: {
        plugins: [pinia],
        stubs: {
          SettingsPopover: defineComponent({
            emits: ["logout"],
            template: "<button @click=\"$emit('logout')\">Log out</button>",
          }),
          FullPopover: true,
          ToolsPopover: true,
          CronPopover: true,
          SessionHeaderStatus: true,
        },
      },
    });
    await wrapper.get('button[popover-id="settings-popover"]').trigger("click");
    await flushPromises();
    expect(api.logout).toHaveBeenCalledOnce();
    expect(store.authenticated).toBe(false);
    expect(store.activeSession).toBeUndefined();
  });
});

describe("restored prompt submission", () => {
  it.each(["submit", "steer"] as const)(
    "does not restore an accepted %s draft when its HTTP response is lost",
    async (kind) => {
      const store = useAppStore();
      store.activeSession = state();
      store.connectionState = "online";
      const restore = vi.fn();
      const handleError = vi.fn();
      const composer = defineComponent({
        name: "MessageComposer",
        emits: ["submit", "steer"],
        setup(_, { expose }) {
          expose({ clear: vi.fn(), restore });
        },
        template: "<div />",
      });
      vi.mocked(api.submitMainPrompt).mockImplementationOnce(
        async (_kind, _text, _files, clientMessageId) => {
          store.activeSession = {
            ...state(2),
            queuedPrompts: [{ kind: "followUp", index: 0, text: "Accepted", clientMessageId }],
          };
          throw new TypeError("Lost response after acceptance");
        },
      );
      wrapper = mount(ChatSessionPane, {
        global: {
          plugins: [pinia],
          config: { errorHandler: handleError },
          stubs: { ChatHeader: true, SessionTranscriptView: true, MessageComposer: composer },
        },
      });
      wrapper.findComponent(composer).vm.$emit(kind, "Accepted", []);
      await flushPromises();
      expect(restore).not.toHaveBeenCalled();
      expect(handleError).not.toHaveBeenCalled();
    },
  );
  it("retries a transport-failed prompt with the original clientMessageId", async () => {
    const store = useAppStore();
    store.activeSession = state();
    store.connectionState = "online";
    vi.mocked(api.submitMainPrompt)
      .mockRejectedValueOnce(new TypeError("Lost response"))
      .mockResolvedValueOnce({
        disposition: "started",
        submissionId: "receipt",
        sessionId: "main",
      });
    const composer = defineComponent({
      name: "MessageComposer",
      emits: ["submit"],
      setup(_, { expose }) {
        expose({ clear: vi.fn(), restore: vi.fn() });
      },
      template: "<div />",
    });
    wrapper = mount(ChatSessionPane, {
      global: {
        plugins: [pinia],
        config: { errorHandler: () => {} },
        stubs: { ChatHeader: true, SessionTranscriptView: true, MessageComposer: composer },
      },
    });
    const child = wrapper.findComponent(composer);
    child.vm.$emit("submit", "Only once", []);
    await flushPromises();
    const originalId = vi.mocked(api.submitMainPrompt).mock.calls[0]![3];
    child.vm.$emit("submit", "Only once", []);
    await flushPromises();
    expect(api.submitMainPrompt).toHaveBeenCalledTimes(2);
    expect(vi.mocked(api.submitMainPrompt).mock.calls[1]![3]).toBe(originalId);
  });
});
