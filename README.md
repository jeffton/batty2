# Batty2

One permanent assistant chat. Workspaces are execution scopes for subagents and scheduled work, not separate user conversations.

## Runtime

- Pi Durable 1.0.2 runs the main conversation, linear workers, queued input, and durable report delivery in SQLite.
- OptChat keeps original entries forever and builds immutable binary summaries. Each main run receives a frozen history view plus its own tool loop. `zoom` retrieves uncompressed non-thought text or child summaries; `date` retrieves a leaf's timestamp. Full message metadata, images, and reasoning remain in the permanent archive.
- Pi Durable automatically compacts subagent and cron worker context while retaining original history; main-inline cron stays on OptChat, and main declines native compaction.
- Subagents support synchronous and asynchronous run, await, queue, resume, steer, and stop. Background results reach the main thread, including work started by another worker.
- Cron supports fresh workers, main-inline execution, and detached workers. `daily-inline` and `daily-detached` are accepted mode names; they target the permanent main thread rather than daily sessions. Fresh-worker cron results also reach main.
- Batty's thread rendering, file tools, browser, web search, sites, attachments, passkeys, MCP, and QuickJS codemode are reused selectively. There is no executor.

State lives in `/var/lib/batty2/.batty`; source lives in `/root/github/batty2`. Existing Batty uses separate state and remains independent. Provider OAuth credentials share the SDK's locked credential store through `BATTY_PROVIDER_AUTH_PATH`; passkeys and application secrets are isolated. Original history and reasoning are retained; reasoning is excluded from memory compression.

Outgoing prompts appear immediately, including attachment names, and survive page refresh until the server publishes the matching user message. Failed submissions restore the draft; cancelled queued prompts remove their outgoing entry.

## Cron CLI

Deployment installs `/usr/local/bin/batty2`. It authenticates with the local state secret and calls the running service's cron runtime; it never opens another scheduler.

```sh
batty2 cron add --workspace roy --prompt 'Læs pt.md' --in 3m \
  --model openai-codex/gpt-6.1-sol --thinking medium \
  --session daily-detached --daily-context chat-only
batty2 cron list --workspace roy
batty2 cron update JOB_ID --enabled false
batty2 cron remove JOB_ID
batty2 cron import --json job.json
batty2 --help
```

`--root` defaults to `/var/lib/batty2`. `--json FILE` accepts request fields (`-` reads stdin); flags override them. Import takes a full Batty2 job, preserves ID/timestamps/nextAt, and rejects collisions. Import disabled jobs before cutover, reconcile their final nextAt after disabling the source scheduler, then enable them. Existing job IDs are not accepted by ordinary `add`.

## Notifications

Web push uses the installed PWA's service worker. Sending a message requests browser permission; authenticated startup resynchronizes granted subscriptions without prompting. Main-thread assistant replies notify even with the app closed; tool handoffs, worker replies and `NO_REPLY` do not. Notification clicks open the permanent chat. VAPID keys and subscriptions live in `.batty/web-push`; `webPushSubject` retains the configured VAPID subject.

## Develop

```sh
pnpm install
pnpm dev
pnpm dev:client
pnpm check
pnpm test
pnpm build
```

## Deploy

```sh
./scripts/deploy.sh
```

The script builds an immutable release, atomically switches `/opt/batty2/current`, and restarts `batty2.service`. Pi Durable resumes committed work without draining complete turns. Shell jobs retain stable execution receipts across restarts. Detached Chromium preserves tabs, cookies, and live page state. A kernel lifetime lock prevents concurrent database writers. Unsafe interrupted external actions are reported as errors rather than repeated.

Deployment files are in `deploy/`. The service listens on loopback port 3148 behind nginx at `https://batty2.roybot.se`. First login requires a setup code printed in the service journal and a new passkey for this hostname.

## Import Roy

Stop `batty2.service` before importing:

```sh
pnpm import --dry-run
pnpm import
```

Only Roy sessions carrying the daily-session marker are selected. Every source record retains provenance; repeated imports are deduplicated. Adding source records is supported only before live main-thread work begins. Referenced attachments and sites retain their route identities. Other workspaces, ordinary sessions, workers, and cron schedules are not imported.

Imported user messages and final assistant replies enter OptChat memory; original tool calls, tool results, and metadata remain in permanent history. Memory preparation runs independently after import and reports progress through `/api/memory/status`. The default summarizer is `openai-codex/gpt-6-luna` with low reasoning; `BATTY_MEMORY_MODEL` and `BATTY_MEMORY_REASONING` configure it. `scripts/prepare-memory.ts` prepares memory without starting HTTP.

## References

- [Pi Durable](https://github.com/earendil-works/pi/tree/main/packages/durable)
- [OptChat specification](https://gist.github.com/VictorTaelin/91837951a5ce5b38f341ec1ba1df6449)
