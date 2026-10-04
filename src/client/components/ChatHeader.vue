<script setup lang="ts">
import { FolderOpen, Settings, Wrench, Clock3 } from "@lucide/vue";
import { useAppStore } from "@/client/stores/app";
import FullPopover from "./FullPopover.vue";
import SettingsPopover from "./SettingsPopover.vue";
import ToolsPopover from "./ToolsPopover.vue";
import CronPopover from "./CronPopover.vue";
import SessionHeaderStatus from "./SessionHeaderStatus.vue";
const store = useAppStore();
</script>
<template>
  <header class="header">
    <div class="header__brand">
      <img src="/favicon.png" alt="" /><strong>{{ store.settings.appearance.title }}</strong>
    </div>
    <button
      type="button"
      class="header__button"
      popovertarget="workspaces-popover"
      aria-label="Agent workspaces"
      title="Agent workspaces"
    >
      <FolderOpen :size="17" />
    </button>
    <button
      type="button"
      class="header__button"
      popovertarget="workers-popover"
      aria-label="Cron and subagents"
      title="Cron and subagents"
    >
      <Clock3 :size="17" />
    </button>
    <button
      type="button"
      class="header__button"
      popovertarget="tools-popover"
      aria-label="MCPs, skills and tools"
      title="MCPs, skills and tools"
    >
      <Wrench :size="17" />
    </button>
    <button
      type="button"
      class="header__button"
      popovertarget="settings-popover"
      aria-label="Settings"
      title="Settings"
    >
      <Settings :size="17" />
    </button>
    <div class="header__spacer" />
    <SessionHeaderStatus
      :model="store.activeSession?.model"
      :context-tokens="store.activeSession?.contextTokens"
      :context-window="store.activeSession?.contextWindow"
      :context-percent="store.activeSession?.contextPercent"
      :connection-state="store.connectionState"
    />
    <FullPopover
      popover-id="workspaces-popover"
      title="Agent workspaces"
      subtitle="Work targets for delegated agents"
    >
      <div class="workspace-list">
        <article v-for="workspace in store.workspaces" :key="workspace.id">
          <strong>{{ workspace.label }}</strong
          ><code>{{ workspace.path }}</code>
        </article>
        <p v-if="!store.workspaces.length" class="muted">No workspaces configured.</p>
      </div>
    </FullPopover>
    <SettingsPopover popover-id="settings-popover" anchor-name="--settings-anchor" />
    <ToolsPopover popover-id="tools-popover" anchor-name="--tools-anchor" />
    <CronPopover popover-id="workers-popover" anchor-name="--workers-anchor" />
  </header>
</template>
<style scoped>
.header {
  position: sticky;
  top: 0;
  z-index: 2;
  display: flex;
  align-items: center;
  gap: 0.25rem;
  min-width: 0;
  padding: calc(var(--safe-area-top) + 0.5rem) calc(var(--safe-area-right) + 0.65rem) 0.5rem
    calc(var(--safe-area-left) + 0.65rem);
  background: var(--color-bg-panel-strong);
  border-bottom: 1px solid var(--color-border-soft);
  box-shadow: var(--color-shadow-header);
}
.header__brand {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  padding-right: 0.5rem;
  font-size: 0.9rem;
}
.header__brand img {
  width: 1.6rem;
  height: 1.6rem;
  border-radius: 0.35rem;
}
.header__button {
  display: grid;
  place-items: center;
  width: 2rem;
  height: 2rem;
  border: 0;
  border-radius: 0.5rem;
  background: transparent;
  color: var(--color-text-subtle);
}
.header__button:hover {
  background: var(--color-bg-elevated);
}
.header__spacer {
  flex: 1;
}
.workspace-list {
  height: 100%;
  overflow-y: auto;
}
.workspace-list article {
  display: flex;
  flex-direction: column;
  gap: 0.3rem;
  padding: 1rem;
  border-bottom: 1px solid var(--color-border-soft);
}
.workspace-list code {
  color: var(--color-text-subtle);
  font-size: 0.75rem;
  overflow-wrap: anywhere;
}
.workspace-list p {
  padding: 1rem;
}
@media (max-width: 420px) {
  .header__brand strong {
    display: none;
  }
}
</style>
