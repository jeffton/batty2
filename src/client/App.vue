<script setup lang="ts">
import { onMounted, onUnmounted, watch } from "vue";
import { useRouter } from "vue-router";
import { useAppStore } from "@/client/stores/app";
const store = useAppStore();
const router = useRouter();
const offline = () => {
  store.connectionState = "offline";
};
const online = () => {
  void store.checkForUpdates();
  void store.recoverConnection();
};
const visible = () => {
  if (document.visibilityState !== "hidden") online();
};
onMounted(() => {
  window.addEventListener("offline", offline);
  window.addEventListener("online", online);
  window.addEventListener("pageshow", online);
  document.addEventListener("visibilitychange", visible);
  void store.bootstrap();
});
onUnmounted(() => {
  window.removeEventListener("offline", offline);
  window.removeEventListener("online", online);
  window.removeEventListener("pageshow", online);
  document.removeEventListener("visibilitychange", visible);
  store.closeStream();
});
watch(
  () => [store.bootstrapped, store.authenticated],
  () => {
    if (store.bootstrapped) void router.replace(store.authenticated ? "/" : "/login");
  },
);
</script>
<template>
  <div class="app-shell">
    <div v-if="!store.bootstrapped" class="center-panel">
      <template v-if="store.bootstrapFailed">
        <p role="alert">{{ store.lastError }}</p>
        <button type="button" @click="store.bootstrap()">Retry</button>
      </template>
      <template v-else
        ><div class="spinner" />
        <p>Booting Batty…</p></template
      >
    </div>
    <RouterView v-else />
  </div>
</template>
