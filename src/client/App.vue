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
  if (store.authenticated) store.openStream();
};
onMounted(() => {
  window.addEventListener("offline", offline);
  window.addEventListener("online", online);
  void store.bootstrap();
});
onUnmounted(() => {
  window.removeEventListener("offline", offline);
  window.removeEventListener("online", online);
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
      <div class="spinner" />
      <p>Booting Batty…</p>
    </div>
    <RouterView v-else />
  </div>
</template>
