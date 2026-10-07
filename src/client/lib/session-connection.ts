import type { ServerEvent } from "@/shared/types";

type ConnectionOptions = {
  path: () => string;
  onConnecting: () => void;
  onOpen?: () => void;
  onEvent: (event: ServerEvent) => void;
  onError: () => void;
  onWatchdog?: () => void;
};

/** Shared SSE lifecycle. Every reconnect resolves its cursor from current state. */
export function createSessionConnection(options: ConnectionOptions) {
  let source: EventSource | undefined;
  let watchdog: ReturnType<typeof setInterval> | undefined;
  let retry: ReturnType<typeof setTimeout> | undefined;
  let lastActivity = 0;
  function close() {
    clearTimeout(retry);
    clearInterval(watchdog);
    retry = undefined;
    watchdog = undefined;
    source?.close();
    source = undefined;
  }
  function open() {
    close();
    options.onConnecting();
    const current = new EventSource(options.path());
    source = current;
    lastActivity = Date.now();
    const touch = () => {
      if (source === current) lastActivity = Date.now();
    };
    current.addEventListener("heartbeat", touch);
    watchdog = setInterval(() => {
      if (document.visibilityState === "hidden") return;
      if (Date.now() - lastActivity > 65_000) open();
      options.onWatchdog?.();
    }, 15_000);
    current.onopen = () => {
      if (source !== current) return;
      touch();
      options.onOpen?.();
    };
    current.onmessage = (message) => {
      if (source !== current) return;
      touch();
      options.onEvent(JSON.parse(message.data) as ServerEvent);
    };
    current.onerror = () => {
      if (source !== current) return;
      options.onError();
      clearTimeout(retry);
      retry = setTimeout(() => {
        if (source === current && navigator.onLine) open();
      }, 2000);
    };
  }
  return { open, close };
}
