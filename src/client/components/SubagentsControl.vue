<script setup lang="ts">
import { PanelRightOpen } from "@lucide/vue";
import { useId } from "vue";
import BasePopover from "./BasePopover.vue";
import SubagentSessionPopover from "./SubagentSessionPopover.vue";
import type { RunningSubagent } from "@/shared/types";

const props = defineProps<{ subagents: RunningSubagent[] }>();
const popoverId = `subagents-${useId()}`;
const sessionPopoverId = (id: string) => `${popoverId}-session-${id}`;
</script>

<template>
  <button
    class="subagents-control"
    type="button"
    :popovertarget="popoverId"
    aria-label="Running subagents"
    aria-haspopup="dialog"
  >
    {{ props.subagents.length }} {{ props.subagents.length === 1 ? "subagent" : "subagents" }}
  </button>
  <BasePopover
    :id="popoverId"
    class="subagents-popover"
    anchor-up
    role="dialog"
    aria-label="Running subagents"
  >
    <h2>Subagents</h2>
    <button
      v-for="agent in props.subagents"
      :key="agent.sessionId"
      type="button"
      class="subagents-popover__session"
      :popovertarget="sessionPopoverId(agent.sessionId)"
      :aria-label="`Open subagent session: ${agent.prompt}`"
    >
      <span class="subagents-popover__details">
        <strong>{{ agent.prompt }}</strong>
        <span>{{ agent.model }} · {{ agent.thinkingLevel }}</span>
        <span>{{ agent.workspaceId }} · {{ agent.sessionId }}</span>
      </span>
      <PanelRightOpen :size="16" />
    </button>
    <SubagentSessionPopover
      v-for="agent in props.subagents"
      :key="agent.sessionId"
      :popover-id="sessionPopoverId(agent.sessionId)"
      :session-id="agent.sessionId"
    />
  </BasePopover>
</template>

<style scoped>
.subagents-control {
  min-width: 44px;
  min-height: 44px;
  flex-shrink: 0;
  padding: 0 0.5rem;
  border: 0;
  border-radius: 0.5rem;
  background: transparent;
  color: var(--color-text-muted);
  font: inherit;
  font-size: 0.78rem;
  white-space: nowrap;
  cursor: pointer;
}

@media (hover: hover) {
  .subagents-control:hover {
    background: var(--color-bg-elevated);
  }
}

:global(.subagents-popover) {
  display: none;
}

:global(.subagents-popover:popover-open) {
  display: flex;
  flex-direction: column;
  width: min(22rem, calc(100vw - 1rem));
  --anchored-popover-max-height: 24rem;
  max-height: 24rem;
  overflow-y: auto;
  gap: 0.25rem;
  padding: 0.5rem;
  border: 1px solid var(--color-border-soft);
  border-radius: 0.75rem;
  background: var(--color-bg-overlay);
  color: var(--color-text);
  box-shadow: var(--color-shadow-popover);
}

.subagents-popover h2 {
  margin: 0;
  padding: 0.5rem;
  font-size: 0.9rem;
}

.subagents-popover__session {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  min-height: 44px;
  height: auto;
  width: 100%;
  padding: 0.6rem 0.5rem;
  border: 0;
  border-radius: 0.5rem;
  background: var(--color-bg-elevated);
  color: inherit;
  text-align: left;
  cursor: pointer;
}

.subagents-popover__details {
  display: grid;
  flex: 1;
  min-width: 0;
  gap: 0.2rem;
  font-size: 0.74rem;
  color: var(--color-text-subtle);
}

.subagents-popover__details strong {
  color: var(--color-text);
  font-size: 0.84rem;
}

.subagents-popover__details > * {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
</style>
