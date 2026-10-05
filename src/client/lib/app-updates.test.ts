import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

beforeEach(() => {
  vi.resetModules();
  sessionStorage.clear();
});
afterEach(() => {
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
});

function responses(shellBuild = "new") {
  const reload = vi.fn();
  vi.stubGlobal("window", { location: { reload } });
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ buildId: "new" }),
      text: async () => `<meta name="batty-build" content="${shellBuild}">`,
    }),
  );
  return reload;
}

it("defers a changed build during drafts/uploads and focused input, then reloads once", async () => {
  const reload = responses();
  const { initializeBuild, blockAppReload, checkAppUpdate } = await import("./app-updates");
  initializeBuild("old");
  let busy = true;
  const unblock = blockAppReload(() => busy);
  await checkAppUpdate();
  expect(reload).not.toHaveBeenCalled();
  busy = false;
  const input = document.createElement("textarea");
  document.body.append(input);
  input.focus();
  await checkAppUpdate();
  expect(reload).not.toHaveBeenCalled();
  input.blur();
  await checkAppUpdate();
  await checkAppUpdate();
  expect(reload).toHaveBeenCalledOnce();
  unblock();
});

it("does not reload an unchanged build", async () => {
  const reload = responses();
  const { initializeBuild, checkAppUpdate } = await import("./app-updates");
  initializeBuild("new");
  await checkAppUpdate();
  expect(reload).not.toHaveBeenCalled();
});

it("rejects an old cached shell and guards against loops across document loads", async () => {
  const reload = responses("old");
  let updates = await import("./app-updates");
  updates.initializeBuild("old");
  await updates.checkAppUpdate();
  expect(reload).not.toHaveBeenCalled();
  responses();
  await updates.checkAppUpdate();
  expect(sessionStorage.getItem("batty:reload-build")).toBe("new");
  vi.resetModules();
  updates = await import("./app-updates");
  updates.initializeBuild("old");
  const secondReload = responses();
  await updates.checkAppUpdate();
  expect(secondReload).not.toHaveBeenCalled();
});

it("releases a failed check so resume can retry", async () => {
  const reload = responses();
  vi.mocked(fetch).mockRejectedValueOnce(new DOMException("Timed out", "TimeoutError"));
  const updates = await import("./app-updates");
  updates.initializeBuild("old");
  await expect(updates.checkAppUpdate()).rejects.toThrow("Timed out");
  await updates.checkAppUpdate();
  expect(reload).toHaveBeenCalledOnce();
});
