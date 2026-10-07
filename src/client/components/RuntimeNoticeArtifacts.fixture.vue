<script setup lang="ts">
import ChatMessage from "./ChatMessage.vue";
import type { UiMessage } from "@/shared/types";
import "@/client/styles.css";
const artifacts = {
  sentFiles: [
    {
      id: "f",
      name: "Cabin.jpg",
      size: 123,
      mimeType: "image/jpeg",
      kind: "image" as const,
      downloadUrl: "/fixture.jpg",
      previewUrl: "/fixture.jpg",
    },
  ],
  sites: [{ id: "s", name: "Morning report", url: "https://example.com/report", public: false }],
  fileChanges: [
    { path: "hello.ts", patch: "--- a/hello.ts\n+++ b/hello.ts\n@@ -1 +1 @@\n-before\n+after\n" },
  ],
};
const messages: UiMessage[] = ["cron", "subagent"].map((kind) => ({
  role: "custom",
  id: kind,
  timestamp: 0,
  customType: `batty-runtime-notice:${kind}`,
  text: "Report",
  data: {
    runtimeNotice: { text: `${kind} result`, markdown: "Cabin attached." },
    runtimeResultArtifacts: artifacts,
    [kind]: { sessionId: "42", runId: kind },
  },
}));
messages.push({
  role: "assistant",
  id: "ordinary",
  timestamp: 0,
  turnPhase: "final",
  blocks: [{ type: "text", text: "Ordinary reply" }],
  ...artifacts,
});
</script>
<template>
  <main style="padding: 12px; max-width: 800px; height: 100vh; overflow-y: auto">
    <ChatMessage
      v-for="message in messages"
      :key="message.id"
      :message="message"
      :allow-session-popovers="false"
    />
  </main>
</template>
