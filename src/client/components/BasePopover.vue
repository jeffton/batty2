<script setup lang="ts">
import { onBeforeUnmount, ref } from "vue";

defineOptions({ inheritAttrs: false });

const props = withDefaults(
  defineProps<{
    as?: "div" | "form";
    mode?: "auto" | "manual";
    anchorUp?: boolean;
    alignViewportRight?: boolean;
  }>(),
  {
    as: "div",
    mode: "auto",
  },
);

const emit = defineEmits<{
  toggle: [event: Event];
}>();

const element = ref<HTMLElement | null>(null);
const anchorStyle = ref<Record<string, string>>({});
let observer: ResizeObserver | undefined;
let layoutObserver: MutationObserver | undefined;
let frame: number | undefined;

function positionAboveAnchor(): void {
  const popover = element.value!;
  const anchor = document.querySelector<HTMLElement>(
    `[popovertarget="${CSS.escape(popover.id)}"]`,
  )!;
  const rect = anchor.getBoundingClientRect();
  const viewport = window.visualViewport;
  const viewportLeft = viewport?.offsetLeft ?? 0;
  const viewportTop = viewport?.offsetTop ?? 0;
  const viewportWidth = viewport?.width ?? window.innerWidth;
  const margin = 8;
  const width = Math.min(popover.offsetWidth, viewportWidth - margin * 2);
  anchorStyle.value = {
    position: "fixed",
    positionArea: "none",
    positionTryFallbacks: "none",
    top: "auto",
    right: "auto",
    bottom: `${window.innerHeight - rect.top + margin}px`,
    left: `${props.alignViewportRight ? viewportLeft + viewportWidth - width - margin : Math.max(viewportLeft + margin, Math.min(rect.right - width, viewportLeft + viewportWidth - width - margin))}px`,
    maxWidth: `${viewportWidth - margin * 2}px`,
    maxHeight: `min(var(--anchored-popover-max-height, 32rem), ${Math.max(0, rect.top - viewportTop - margin * 2)}px)`,
    margin: "0",
  };
}

function stopPositioning(): void {
  observer?.disconnect();
  layoutObserver?.disconnect();
  window.removeEventListener("resize", positionAboveAnchor);
  window.removeEventListener("scroll", positionAboveAnchor, true);
  window.visualViewport?.removeEventListener("resize", positionAboveAnchor);
  window.visualViewport?.removeEventListener("scroll", positionAboveAnchor);
  if (frame !== undefined) cancelAnimationFrame(frame);
}

function handleBeforeToggle(event: Event): void {
  if (!props.anchorUp) return;
  stopPositioning();
  if ((event as ToggleEvent).newState !== "open") return;
  frame = requestAnimationFrame(() => {
    positionAboveAnchor();
    observer = new ResizeObserver(positionAboveAnchor);
    observer.observe(element.value!);
    const anchor = document.querySelector<HTMLElement>(
      `[popovertarget="${CSS.escape(element.value!.id)}"]`,
    )!;
    observer.observe(anchor);
    const container = anchor.parentElement!.parentElement!;
    observer.observe(container);
    layoutObserver = new MutationObserver(positionAboveAnchor);
    layoutObserver.observe(container, {
      subtree: true,
      childList: true,
      attributes: true,
      characterData: true,
    });
    window.addEventListener("resize", positionAboveAnchor);
    window.addEventListener("scroll", positionAboveAnchor, true);
    window.visualViewport?.addEventListener("resize", positionAboveAnchor);
    window.visualViewport?.addEventListener("scroll", positionAboveAnchor);
  });
}

onBeforeUnmount(stopPositioning);

function showPopover(): void {
  element.value?.showPopover();
}

function hidePopover(): void {
  element.value?.hidePopover();
}

function togglePopover(force?: boolean): void {
  element.value?.togglePopover(force);
}

defineExpose({ element, showPopover, hidePopover, togglePopover });
</script>

<template>
  <!-- Teleport isolates ancestor styles. Callers must use :global for their
       unique root class: Vue does not forward caller scope IDs through Teleport. -->
  <Teleport to="body">
    <component
      :is="props.as"
      ref="element"
      class="base-popover"
      :popover="props.mode"
      v-bind="$attrs"
      :style="anchorStyle"
      @beforetoggle="handleBeforeToggle"
      @toggle="emit('toggle', $event)"
    >
      <slot />
    </component>
  </Teleport>
</template>

<style scoped>
.base-popover {
  overscroll-behavior: contain;
}
</style>
