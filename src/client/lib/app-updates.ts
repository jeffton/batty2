import { withBaseUrl } from "./base-url";

const blockers = new Set<() => boolean>();
declare const __BATTY_BUILD_ID__: string;
let loadedBuild: string | undefined = __BATTY_BUILD_ID__ === "dev" ? undefined : __BATTY_BUILD_ID__;
let pendingBuild: string | undefined;
let checking: Promise<void> | undefined;
let reloading = false;

export function blockAppReload(blocked: () => boolean): () => void {
  blockers.add(blocked);
  return () => blockers.delete(blocked);
}

export function canReloadApp(): boolean {
  return (
    document.visibilityState !== "hidden" &&
    !document.activeElement?.matches("input, textarea, [contenteditable=true]") &&
    ![...blockers].some((blocked) => blocked())
  );
}

export function initializeBuild(buildId: string | undefined): void {
  loadedBuild ??= buildId;
}

async function fetchAvailable(path: string, label: string): Promise<Response> {
  for (let attempt = 0; ; attempt += 1) {
    const response = await fetch(withBaseUrl(path), {
      cache: "no-store",
      signal: AbortSignal.timeout(10_000),
    });
    if (response.ok) return response;
    // Deploys can briefly leave the proxy without a healthy backend. Wait for
    // it rather than navigating into the same outage. Persistent errors surface.
    if (attempt >= 2 || ![502, 503, 504].includes(response.status)) {
      throw new Error(`${label} check failed: ${response.status}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 5_000));
  }
}

export async function checkAppUpdate(): Promise<void> {
  if (checking) return checking;
  checking = (async () => {
    const response = await fetchAvailable("/api/version", "Version");
    const { buildId } = await response.json();
    initializeBuild(buildId);
    pendingBuild = buildId !== loadedBuild ? buildId : undefined;
    if (!pendingBuild || reloading || !canReloadApp()) return;
    if (sessionStorage.getItem("batty:reload-build") === pendingBuild) return;
    // Verify online HTML before navigating; an offline cached shell must not loop.
    const shell = await fetchAvailable("/index.html", "App shell");
    const html = new DOMParser().parseFromString(await shell.text(), "text/html");
    if (html.querySelector('meta[name="batty-build"]')?.getAttribute("content") !== pendingBuild)
      return;
    // Worker updates run independently, without plugin-controlled page reloads.
    void navigator.serviceWorker
      ?.getRegistration()
      .then((registration) => registration?.update())
      .catch(console.error);
    if (!canReloadApp()) return;
    sessionStorage.setItem("batty:reload-build", pendingBuild);
    reloading = true;
    window.location.reload();
  })().finally(() => {
    checking = undefined;
  });
  return checking;
}
