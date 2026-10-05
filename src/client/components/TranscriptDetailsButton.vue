<script setup lang="ts">
import { ChevronDown, ChevronUp } from "@lucide/vue";

defineProps<{ expanded: boolean }>();
const emit = defineEmits<{ toggle: [] }>();
</script>

<template>
  <button
    type="button"
    class="details-button"
    :aria-expanded="expanded"
    :aria-label="expanded ? 'Collapse details' : 'Show details'"
    :title="expanded ? 'Collapse details' : 'Show details'"
    @click="emit('toggle')"
  >
    <ChevronUp v-if="!expanded" :size="22" />
    <ChevronDown v-else :size="22" />
  </button>
</template>

<style scoped>
.details-button {
  width: 44px;
  height: 44px;
  padding: 0;
  border: 0;
  border-radius: 0.5rem;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  color: var(--color-text-muted);
  background: transparent;
  cursor: pointer;
}

@media (hover: hover) {
  .details-button:hover {
    background: var(--color-bg-elevated);
    color: var(--color-text);
  }
}
</style>
