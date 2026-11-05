# AGENTS.md

Guidance for coding agents working in this repository.

## What this is

`claude-relay` is a small HTTP service that runs headless Claude Code (`claude --print`) sessions inside a Coder workspace, so `claude` can be driven from outside the workspace through Coder's app proxy. It is only meant to run inside a Coder workspace: Coder handles authentication, so the service itself has none and listens on loopback only.

Its primary consumer is [Rakazo](https://rakazo.com)'s **Cloud Agent** integration ([docs](https://rakazo.com/docs/self-host-integrations/#cloud-coding-agents)). The service was extracted from `infra/claude-code-runner` in the fork <https://github.com/HonzaKirchner/rakazo> (commit `951f012`, "coder runner"). **Upstream [elie222/rakazo](https://github.com/elie222/rakazo) has neither the runner nor a Coder provider**: upstream only knows the `cursor` and `emulator` providers, and treats any other `CLOUD_AGENT_PROVIDER` value as `none`. Upstream rakazo can only reach this service through the fork's Coder adapter.

## Terminology

| Term | Meaning |
| --- | --- |
| **conversation** | One Claude Code session with its own branch and PR in the workspace's one checkout. Created by a launch, extended by follow-ups. Rakazo calls it an **agent**: the HTTP API also answers under `/agents/:id` for Rakazo, and the `agent/<id>` branch keeps that name. |
| **checkout** | The one git checkout (`RUNNER_WORKDIR`) every conversation works in, the codebase the workspace builds and serves. One run at a time, because there is one checkout. |
| **run** | One prompt sent to the conversation: one `claude --print` process with its own `runId` and status. |
| **event** | One stream-json line a run printed (`system`, `assistant`, `user`, `result`, ...). |
| **tool call** | A `tool_use` block from an assistant event, paired with its `tool_result`. |

Use these names in code and the database; use "agent" only where Rakazo's contract requires it.

## Layout

| File | Role |
| --- | --- |
| `src/index.ts` | Entry point: reads env, loads state, listens on `127.0.0.1:$PORT`. |
| `src/http.ts` | Routing, request validation, error → status mapping. |
| `src/runner.ts` | `ConversationRunner`: the shared checkout and its lock, per-conversation branches, `claude` process, commit/push/PR, persistence. |
| `src/ui.ts` | HTML pages served at `/ui/conversations/:id` and `/ui/conversations` (the list), and `LiveRunRenderer`, which turns a running run's events into changes to the open page. |
| `src/db.ts` | `Store`: the PostgreSQL store, the only place conversations, runs, events and tool calls are kept (`db/schema.sql`). Required: the service exits without `DB_CONNECTION_STRING` or a reachable database. |
| `src/log.ts` | One-line `key=value` logger, filtered by `LOG_LEVEL`. |
| `src/runner.test.ts` | End-to-end tests over HTTP with fake `claude` and `gh` scripts and a local git origin. | Needs PostgreSQL, see `test/postgres.ts`. |
| `test/postgres.ts` | Vitest global setup: a throwaway test database (Docker, or a fresh database on `TEST_DATABASE_URL`). |
| `scripts/import-files.ts` | `npm run db:import`: one-time import of conversations older versions kept in files. |
| `scripts/db.ts` | `npm run db:start` / `db:stop` / `db:reset`: a local PostgreSQL in Docker matching `DB_CONNECTION_STRING`. |
| `scripts/seed.ts` | `npm run db:seed`: sample conversations (`seed-*`) for the pages and API, written through `Store`. Keep its events shaped like real stream-json when the event handling changes. |

## Commands

Node ≥ 22.18 runs the TypeScript source directly (type stripping); there is no build step.

```bash
npm install      # dev deps only: typescript, vitest, @types/node
npm run check    # tsc --noEmit
npm test         # vitest; needs PostgreSQL (Docker, or TEST_DATABASE_URL)
npm start        # node src/index.ts
npm run db:start # local PostgreSQL in Docker (see README "Development" for the .env)
npm run db:seed  # sample conversations
npm run dev      # db:start, then the service with --watch
```

Run `npm run check` and `npm test` before finishing any change.

In an apix dev sandbox, [`apix.yaml`](apix.yaml) defines the `relay` service and the `test` and `check` tasks. Node comes from `.nvmrc`. If you rename the startup log line in `src/index.ts`, also update `ready_when` in `apix.yaml`.

## Code rules

- **One runtime dependency, `pg`.** Only `src/db.ts` may import it. Everything else in `src/` uses only `node:` built-ins. Do not add other runtime dependencies; dev dependencies are fine.
- Only erasable TypeScript (`erasableSyntaxOnly`): no enums, namespaces or parameter properties. Import local files with the `.ts` extension.
- Child processes are spawned `detached` and stopped by process group, so cancel also kills anything `claude` started. Keep that when adding commands; route them through `AgentRunner.exec` so cancel can reach them.
- Log through `src/log.ts` (`log.info(message, { conversation, run, ... })`), not `console`. Never log prompts or tokens. Keep the `claude-code-runner listening on` startup line: apix's `ready_when` matches it.
- **The database is the only store.** Conversations, runs, events and Claude's stderr go to PostgreSQL through `Store`, never to files; the checkout holds only the code. Store a launch or follow-up before starting it, and fail the request if that write fails. Schema changes must be additive and idempotent in `db/schema.sql` (existing databases are migrated in place on start).
- **One checkout, one run at a time.** Every run works in `RUNNER_WORKDIR` on the conversation's branch, so the runner holds a single lock (`current`) across all conversations and refuses, never queues, a run while another is going or while the checkout is dirty. Take the lock before the first `await` of a launch or follow-up, and release it only once the run has ended. Never clone, and never touch the checkout outside a run.

## The Rakazo Cloud Agent contract

The contract has two layers:

1. **Provider-neutral, owned by upstream rakazo.** This is the `CloudAgentProvider` interface (`packages/adapter-kit/src/interfaces.ts`, types in `types.ts`, errors in `cloud-agents.ts`). The behaviour core relies on lives in `packages/adapters/src/cloud-agent-poll.ts`, and `cloud-agent-conformance.test.ts` and the Cursor adapter serve as the reference. See "Semantics Rakazo relies on" below.
2. **HTTP wire format, owned by the fork's adapter** `packages/adapters/src/coder-cloud-agent.ts` (`CoderCloudAgentProvider`). It maps the interface onto the endpoints below. Check that adapter before changing anything observable here.

### Transport

- Rakazo reaches the service through Coder's app proxy at `/@<owner>/<workspace>/apps/claude/<path>`, authenticated by the workspace owner's Coder token. The app slug **`claude` is hard-coded in Rakazo** (`APP_SLUG` in `coder-cloud-agent.ts`; it was `claude-code-runner` before the fork's commit `51840fb`). The adapter builds the conversation page link itself from that path, so `url` in responses is for other callers.
- The service itself does no authentication and listens on loopback only, by design: it runs only inside a Coder workspace. Do not add a non-loopback listener without adding authentication.
- Rakazo treats a non-JSON or code-less error response as "workspace not reachable" and starts the workspace. So **every response from this service must be JSON**, and every error must carry a `code`.
- Rakazo reads at most 1 MB of a response and times out requests after 30 s.

### Endpoints

All bodies are JSON. `:id` and `:runId` match `[A-Za-z0-9_-]{1,128}`.

The canonical paths start with `/conversations`. Every one of them is also served under `/agents` (`/agents/:id`, `/agents/:id/runs`, `/ui/agents/:id`, ...), with identical behaviour. **The fork's Coder adapter calls the `/agents` paths, so they must keep working** until it moves to `/conversations`.

| Method & path | Body | Behaviour |
| --- | --- | --- |
| `GET /health` | – | `{ "ok": true }` |
| `PUT /conversations/:id` | `LaunchRequest` | Creates the conversation and its first run. **Idempotent**: repeating it with the same id returns the existing conversation's latest run and starts nothing. `409 busy` while any conversation's run is going (`reason: "locked"`) or while the checkout has uncommitted changes (`reason: "dirty"`); neither creates the conversation. |
| `GET /conversations/:id` | – | Latest run. |
| `GET /conversations/:id/runs/:runId` | – | A specific run. |
| `POST /conversations/:id/runs` | `PromptRequest` | Starts a follow-up that resumes the same Claude session. `409 busy` while any conversation's run is going (`locked`), or while the checkout has uncommitted changes that are not this conversation's own (`dirty`). |
| `GET /ui/conversations/:id` | – | HTML page with the conversation and a sidebar listing every conversation, for people. Rakazo never calls it. |
| `GET /ui/conversations` | – | HTML page with just the conversation list. |
| `GET /ui/conversations/:id/stream?run=&after=` | – | Server-sent events for the conversation page: `patch` with HTML changes as the running run prints events, `reload` when a run starts or ends. Fed from memory by `ConversationRunner.subscribe`, not the database. Rakazo never calls it. Together with the two pages above, the only non-JSON success responses. |
| `POST /conversations/:id/runs/:runId/cancel` | `{}` | Stops the run and **responds only once it has stopped**, with the final state. Cancelling a finished run returns it unchanged. |
| `POST /conversations/:id/runs/:runId/messages` | `PromptRequest` | Steers the running run: stores the message (`run_messages`), then writes it to `claude`'s stdin. `409 not_running` if the run is not going, was cancelled, or Claude has answered everything and the run is publishing. Used by the conversation page; Rakazo never calls it. |

```ts
type Image = { data: string; mimeType: "image/png" | "image/jpeg" | "image/gif" | "image/webp" } | { url: string };
interface PromptRequest { prompt: string /* non-blank, ≤ 100 000 chars */; images?: Image[] /* ≤ 5 */ }
interface LaunchRequest extends PromptRequest {
  repository?: string;  // https URL; part of Rakazo's contract, validated and ignored: the work happens in the checkout
  openPr?: boolean;
  baseBranch?: string;  // what the conversation's branch starts from; default RUNNER_BASE_BRANCH, else the origin's default branch
}
```

Every success response is a `ConversationView` (the fork's adapter calls the same shape `AgentView`):

```ts
interface ConversationView {
  id: string;
  title: string;            // first line of the launch prompt, ≤ 80 chars
  status: "running" | "finished" | "failed" | "cancelled";
  runId: string;            // the run described; must match ^[A-Za-z0-9_-]+$ (Rakazo validates it)
  latestRunId: string;      // the conversation's latest run, even when another run was asked for
  branch?: string;          // only once pushed
  prUrl?: string;
  error?: string;
  summary?: string;         // the run's final answer: text of its last successful `result`, ≤ 20 000 chars
                            // (Rakazo's CLOUD_AGENT_SUMMARY_MAX); for a failed run without one, its `error`
  url?: string;             // conversation page `${APP_URL}/ui/conversations/:id`; only when APP_URL is set
}
```

Errors are `{ "code": ... }`, and Rakazo maps them as follows:

| Status | `code` | Rakazo's reaction |
| --- | --- | --- |
| 400 | `invalid` | Request rejected, not retried. |
| 404 | `not_found` | Agent gone, not retried. |
| 409 | `busy` | Launch or follow-up refused. Rakazo observes the current run instead of resending. The body adds, additively, `reason`: `locked` (a run is going, and `conversation` names whose) or `dirty` (the checkout has uncommitted changes that are not the conversation's own, and `branch` names the branch it is on; someone has to commit, stash or discard them in the workspace). **Check**: Rakazo's adapter handled `busy` only for a follow-up of the running conversation; a launch, or a follow-up of an idle conversation, refused because *another* conversation runs or the checkout is dirty is new to it. |
| 409 | `not_running` | Steering message refused (only `POST .../messages`, which Rakazo does not call). |
| 500 | `internal` | Generic failure. |
| 404 | `route_not_found` | Generic failure. |

### Semantics Rakazo relies on

- **Agent ids** are chosen by Rakazo: the first 32 hex chars of a SHA-256 of its idempotency key. Launch idempotency is what makes a lost launch response safe to resend.
- **Runs**: each launch or follow-up creates a new `runId`. Rakazo tracks follow-ups by `runId` and polls `GET /agents/:id/runs/:runId` (the alias), so old runs must stay readable.
- **What Rakazo shows**: of a view it reads only `id`, `title`, `status`, `runId`, `branch`, `prUrl` and `summary` (`agentSchema` in the adapter); `error`, `latestRunId` and `url` are ignored. Its card and its `cloud_agent_status` tool show `summary` as the run's outcome, and it stores up to 20 000 characters of it. A new run must come with no summary (the previous reply must not linger), and a failed run carries its `error` as the summary so the failure is visible in Rakazo. Rakazo writes its own title from the prompt; ours is a fallback.
- **Sessions**: runs use `--session-id <uuid>` until Claude has created the session (its `system/init` event), then `--resume <uuid>`, so context carries over. A run where Claude exits before creating it, e.g. refusing to start, leaves the next run to create it.
- **The checkout**: every conversation works in `RUNNER_WORKDIR`, the workspace's one checkout, on branch `agent/<first 12 chars of id>`. The launch's `repository` is ignored (the conversation records the checkout's origin instead). A new conversation's branch is fetched and created from `baseBranch`, else `RUNNER_BASE_BRANCH`, else the origin's default branch. Each run first puts the checkout on the conversation's branch (restoring it from the origin if the checkout lost it and it was pushed, else starting again from the base). When a run finishes successfully, leftover changes are committed with the title as message, the branch is pushed, and with `openPr` one PR is opened (or the existing one reused) via `gh`. Failed or cancelled runs publish nothing and leave their changes in the checkout: the same conversation goes on from them, every other request is refused with `busy` (`reason: "dirty"`) until someone deals with them.
- **One run at a time**: there is one checkout, so a launch or follow-up while any conversation's run is going is refused with `busy` (`reason: "locked"`); nothing is queued. The checkout is left on the last conversation's branch, so what the workspace builds and serves is that conversation's work.
- **Restarts**: a run that was `running` when the service stopped is reported as `failed` on the next start. Conversations live only in PostgreSQL (`DB_CONNECTION_STRING`); the checkout must survive restarts too, with the conversations' branches in it.
- **Workspace lifecycle** (start on demand, retry later) is Rakazo's job, not this service's.
- **Lost follow-up responses**: upstream's poller never resends a follow-up blindly. It calls `GET /agents/:id` and treats a new `runId` as proof the follow-up was accepted. So the latest run must be visible as soon as `POST /agents/:id/runs` returns.
- **Steering**: `claude`'s stdin stays open after the prompt so messages can be written to it mid-run. It is closed once Claude has printed a `result` for every message written; if Claude merged a mid-turn message into the turn it was on, results stay behind, so stdin is also closed after `STEER_IDLE_MS` without output following a `result`. Closing stdin is what makes `claude --print` exit, so keep both rules.
- **Cancel by run**: the poller cancels the run it is tracking. Cancelling an older, already-finished run must return that run unchanged and must not touch a newer one.
- **`expired`**: the interface also has an `expired` status (agent gone or archived). This service never reports it. Agents and their branches are kept forever.

### Changing the contract

Additive changes (new optional response fields, new endpoints) are safe. Anything else — renaming fields, changing status codes or error codes, changing idempotency or cancel semantics, changing the branch naming — needs a matching change in Rakazo's `coder-cloud-agent.ts` and its tests. Update this file and `README.md` with any contract change.
