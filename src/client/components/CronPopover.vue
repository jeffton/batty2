<script setup lang="ts">
import { onBeforeUnmount, ref } from "vue";
import FullPopover from "./FullPopover.vue";
import SubagentSessionPopover from "./SubagentSessionPopover.vue";
import {
  listRunningSubagents,
  listWorkspaceCronJobs,
  listWorkspaceCronRunLogs,
} from "@/client/lib/api";
import { useAppStore } from "@/client/stores/app";
import type { CronJob, CronRunLog, RunningSubagent } from "@/shared/types";
const props = defineProps<{ popoverId: string; anchorName: string }>();
const store = useAppStore();
const jobs = ref<CronJob[]>([]);
const logs = ref<CronRunLog[]>([]);
const subagents = ref<RunningSubagent[]>([]);
const error = ref("");
const loading = ref(false);
let open = false;
let timer: ReturnType<typeof setTimeout> | undefined;
let generation = 0;
async function refresh() {
  const request = ++generation;
  loading.value = true;
  try {
    const [agents, workspaceData] = await Promise.all([
      listRunningSubagents(store.activeSession!.id),
      Promise.all(
        store.workspaces.map(async (workspace) => ({
          jobs: await listWorkspaceCronJobs(workspace.id),
          logs: await listWorkspaceCronRunLogs(workspace.id),
        })),
      ),
    ]);
    if (request !== generation) return;
    subagents.value = agents;
    jobs.value = workspaceData.flatMap((data) => data.jobs);
    logs.value = workspaceData
      .flatMap((data) => data.logs)
      .sort((a, b) => b.startedAtMs - a.startedAtMs);
    error.value = "";
  } catch (cause) {
    if (request === generation)
      error.value = cause instanceof Error ? cause.message : String(cause);
  } finally {
    if (request === generation) {
      loading.value = false;
      if (open) timer = setTimeout(() => void refresh(), 3000);
    }
  }
}
function toggle(event: Event) {
  open = (event as ToggleEvent).newState === "open";
  clearTimeout(timer);
  if (open) void refresh();
  else generation++;
}
onBeforeUnmount(() => {
  open = false;
  generation++;
  clearTimeout(timer);
});
</script>
<template>
  <FullPopover
    :popover-id="props.popoverId"
    :anchor-name="props.anchorName"
    title="Cron and subagents"
    @toggle="toggle"
  >
    <div class="workers">
      <p v-if="error" role="alert" class="workers__error">{{ error }}</p>
      <p v-if="loading && !jobs.length && !subagents.length" class="muted">Loading…</p>
      <h3>Subagents</h3>
      <article v-for="agent in subagents" :key="agent.sessionId">
        <p>{{ agent.prompt }}</p>
        <small>{{ agent.model }}</small>
        <button type="button" :popovertarget="`worker-${agent.sessionId}`">
          View live transcript
        </button>
        <SubagentSessionPopover
          :popover-id="`worker-${agent.sessionId}`"
          :session-id="agent.sessionId"
        />
      </article>
      <p v-if="!subagents.length" class="muted">No running subagents.</p>
      <h3>Scheduled jobs</h3>
      <article v-for="job in jobs" :key="job.id">
        <p>{{ job.prompt }}</p>
        <small>{{ job.scheduleLabel }} · {{ job.enabled ? "Enabled" : "Paused" }}</small>
      </article>
      <p v-if="!jobs.length" class="muted">No scheduled jobs.</p>
      <h3>Recent runs</h3>
      <article v-for="run in logs" :key="run.runId">
        <p>{{ run.prompt }}</p>
        <small>{{ run.status }} · {{ new Date(run.startedAtMs).toLocaleString() }}</small>
        <p v-if="run.error" class="workers__error">{{ run.error }}</p>
        <template v-if="run.sessionId"
          ><button type="button" :popovertarget="`cron-${run.runId}`">View transcript</button
          ><SubagentSessionPopover
            :popover-id="`cron-${run.runId}`"
            :session-id="run.sessionId"
            header-title="Cron run"
        /></template>
      </article>
    </div>
  </FullPopover>
</template>
<style scoped>
.workers {
  height: 100%;
  overflow-y: auto;
  padding: 1rem;
}
.workers h3 {
  font-size: 0.9rem;
  margin: 1rem 0 0.5rem;
}
.workers article {
  display: flex;
  flex-direction: column;
  gap: 0.45rem;
  padding: 0.75rem 0;
  border-bottom: 1px solid var(--color-border-soft);
}
.workers p {
  margin: 0;
  font-size: 0.85rem;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
.workers small {
  color: var(--color-text-subtle);
}
.workers button {
  align-self: flex-start;
  border: 0;
  border-radius: 0.5rem;
  padding: 0.45rem 0.65rem;
  background: var(--color-bg-elevated);
  color: inherit;
}
.workers__error {
  color: var(--color-error);
}
</style>
