<script setup lang="ts">
import { Check, Copy } from "@lucide/vue";
defineProps<{ copied: boolean }>();
const emit = defineEmits<{ copy: [] }>();
</script>

<template>
  <div class="reply-actions">
    <button
      type="button"
      :aria-label="copied ? 'Copied reply markdown' : 'Copy reply as markdown'"
      :title="copied ? 'Copied' : 'Copy reply as markdown'"
      @click="emit('copy')"
    >
      <Check v-if="copied" :size="22" />
      <Copy v-else :size="22" />
    </button>
    <slot />
  </div>
</template>

<style scoped>
.reply-actions {
  float: right;
  position: relative;
  z-index: 2;
  display: flex;
  flex-direction: row;
  margin: -0.5rem -0.65rem 0.35rem 0.5rem;
}

button {
  width: 44px;
  height: 44px;
  padding: 0;
  border: 0;
  border-radius: 0.5rem;
  background: transparent;
  color: var(--color-text-muted);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
}

@media (hover: hover) {
  button:hover {
    background: var(--color-bg-elevated);
    color: var(--color-text);
  }
}
</style>
