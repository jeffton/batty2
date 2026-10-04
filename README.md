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
