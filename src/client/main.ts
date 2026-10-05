import { createApp } from "vue";
import { createPinia } from "pinia";
import piniaPluginPersistedstate from "pinia-plugin-persistedstate";
import { withBaseUrl } from "@/client/lib/base-url";
import polyfillAnchorPositioning from "@oddbird/css-anchor-positioning/fn";
import App from "@/client/App.vue";
import { installPopoverBackdropClickGuard } from "@/client/lib/popover-backdrop";
import { router } from "@/client/router";
import "@/client/styles.css";

// The worker claims clients without reloading them. Version checks reload only
// when the composer and uploads are idle.
if (import.meta.env.PROD && "serviceWorker" in navigator) {
  void navigator.serviceWorker.register(withBaseUrl("/sw.js"), { updateViaCache: "none" });
}

if (!("anchorName" in document.documentElement.style)) {
  await polyfillAnchorPositioning();
}

installPopoverBackdropClickGuard();

const pinia = createPinia();
pinia.use(piniaPluginPersistedstate);

const app = createApp(App);
app.use(pinia);
app.use(router);
app.mount("#app");
