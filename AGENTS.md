# AGENTS.md

Guidance for coding agents working in this repository.

## What this is

`claude-relay` is a small HTTP service that runs headless Claude Code (`claude --print`) sessions inside a Coder workspace, so `claude` can be driven from outside the workspace through Coder's app proxy. It is only meant to run inside a Coder workspace: Coder handles authentication, so the service itself has none and listens on loopback only.

Its primary consumer is [Rakazo](https://rakazo.com)'s **Cloud Agent** integration ([docs](https://rakazo.com/docs/self-host-integrations/#cloud-coding-agents)). The service was extracted from `infra/claude-code-runner` in the fork <https://github.com/HonzaKirchner/rakazo> (commit `951f012`, "coder runner"). **Upstream [elie222/rakazo](https://github.com/elie222/rakazo) has neither the runner nor a Coder provider**: upstream only knows the `cursor` and `emulator` providers, and treats any other `CLOUD_AGENT_PROVIDER` value as `none`. Upstream rakazo can only reach this service through the fork's Coder adapter.

## Terminology

| Term | Meaning |
| --- | --- |
| **conversation** | One Claude Code session with its own checkout, branch and PR. Created by a launch, extended by follow-ups. Rakazo calls it an **agent**: the HTTP API also answers under `/agents/:id` for Rakazo, and the `agent/<id>` branch keeps that name. |
| **run** | One prompt sent to the conversation: one `claude --print` process with its own `runId` and status. |
| **event** | One stream-json line a run printed (`system`, `assistant`, `user`, `result`, ...). |
| **tool call** | A `tool_use` block from an assistant event, paired with its `tool_result`. |

Use these names in code and the database; use "agent" only where Rakazo's contract requires it.

## Layout

| File | Role |
| --- | --- |
| `src/index.ts` | Entry point: reads env, loads state, listens on `127.0.0.1:$PORT`. |
| `src/http.ts` | Routing, request validation, error → status mapping. |
| `src/runner.ts` | `ConversationRunner`: per-conversation checkout, `claude` process, commit/push/PR, persistence. |
| `src/ui.ts` | HTML conversation page served at `/ui/conversations/:id`. |
| `src/db.ts` | `Store`: the PostgreSQL store, the only place conversations, runs, events and tool calls are kept (`db/schema.sql`). Required: the service exits without `DB_CONNECTION_STRING` or a reachable database. |
| `src/log.ts` | One-line `key=value` logger, filtered by `LOG_LEVEL`. |
| `src/runner.test.ts` | End-to-end tests over HTTP with fake `claude` and `gh` scripts and a local git origin. | Needs PostgreSQL, see `test/postgres.ts`. |
| `test/postgres.ts` | Vitest global setup: a throwaway test database (Docker, or a fresh database on `TEST_DATABASE_URL`). |
| `scripts/import-files.ts` | `npm run db:import`: one-time import of conversations older versions kept in files. |

## Commands

Node ≥ 22.18 runs the TypeScript source directly (type stripping); there is no build step.

```bash
npm install      # dev deps only: typescript, vitest, @types/node
npm run check    # tsc --noEmit
npm test         # vitest; needs PostgreSQL (Docker, or TEST_DATABASE_URL)
npm start        # node src/index.ts
```

Run `npm run check` and `npm test` before finishing any change.

In an apix dev sandbox, [`apix.yaml`](apix.yaml) defines the `relay` service and the `test` and `check` tasks. Node comes from `.nvmrc`. If you rename the startup log line in `src/index.ts`, also update `ready_when` in `apix.yaml`.

## Code rules

- **One runtime dependency, `pg`.** Only `src/db.ts` may import it. Everything else in `src/` uses only `node:` built-ins. Do not add other runtime dependencies; dev dependencies are fine.
- Only erasable TypeScript (`erasableSyntaxOnly`): no enums, namespaces or parameter properties. Import local files with the `.ts` extension.
- Child processes are spawned `detached` and stopped by process group, so cancel also kills anything `claude` started. Keep that when adding commands; route them through `AgentRunner.exec` so cancel can reach them.
- Log through `src/log.ts` (`log.info(message, { conversation, run, ... })`), not `console`. Never log prompts or tokens. Keep the `claude-code-runner listening on` startup line: apix's `ready_when` matches it.
- **The database is the only store.** Conversations, runs, events and Claude's stderr go to PostgreSQL through `Store`, never to files; the data directory holds only git checkouts. Store a launch or follow-up before starting it, and fail the request if that write fails. Schema changes must be additive and idempotent in `db/schema.sql` (existing databases are migrated in place on start).

## The Rakazo Cloud Agent contract

The contract has two layers:

1. **Provider-neutral, owned by upstream rakazo.** This is the `CloudAgentProvider` interface (`packages/adapter-kit/src/interfaces.ts`, types in `types.ts`, errors in `cloud-agents.ts`). The behaviour core relies on lives in `packages/adapters/src/cloud-agent-poll.ts`, and `cloud-agent-conformance.test.ts` and the Cursor adapter serve as the reference. See "Semantics Rakazo relies on" below.
2. **HTTP wire format, owned by the fork's adapter** `packages/adapters/src/coder-cloud-agent.ts` (`CoderCloudAgentProvider`). It maps the interface onto the endpoints below. Check that adapter before changing anything observable here.

### Transport

- Rakazo reaches the service through Coder's app proxy at `/@<owner>/<workspace>/apps/claude-code-runner/<path>`, authenticated by the workspace owner's Coder token. The app slug **`claude-code-runner` is hard-coded in Rakazo**.
- The service itself does no authentication and listens on loopback only, by design: it runs only inside a Coder workspace. Do not add a non-loopback listener without adding authentication.
- Rakazo treats a non-JSON or code-less error response as "workspace not reachable" and starts the workspace. So **every response from this service must be JSON**, and every error must carry a `code`.
- Rakazo reads at most 1 MB of a response and times out requests after 30 s.

### Endpoints

All bodies are JSON. `:id` and `:runId` match `[A-Za-z0-9_-]{1,128}`.

The canonical paths start with `/conversations`. Every one of them is also served under `/agents` (`/agents/:id`, `/agents/:id/runs`, `/ui/agents/:id`, ...), with identical behaviour. **The fork's Coder adapter calls the `/agents` paths, so they must keep working** until it moves to `/conversations`.

| Method & path | Body | Behaviour |
| --- | --- | --- |
| `GET /health` | – | `{ "ok": true }` |
| `PUT /conversations/:id` | `LaunchRequest` | Creates the conversation and its first run. **Idempotent**: repeating it with the same id returns the existing conversation's latest run and starts nothing. |
| `GET /conversations/:id` | – | Latest run. |
| `GET /conversations/:id/runs/:runId` | – | A specific run. |
| `POST /conversations/:id/runs` | `PromptRequest` | Starts a follow-up that resumes the same Claude session. `409 busy` while a run is going. |
| `GET /ui/conversations/:id` | – | HTML page with the conversation, for people. The only non-JSON success response; Rakazo never calls it. |
| `POST /conversations/:id/runs/:runId/cancel` | `{}` | Stops the run and **responds only once it has stopped**, with the final state. Cancelling a finished run returns it unchanged. |

```ts
type Image = { data: string; mimeType: "image/png" | "image/jpeg" | "image/gif" | "image/webp" } | { url: string };
interface PromptRequest { prompt: string /* non-blank, ≤ 100 000 chars */; images?: Image[] /* ≤ 5 */ }
interface LaunchRequest extends PromptRequest { repository?: string /* https URL */; openPr?: boolean }
```

Every success response is a `ConversationView` (the fork's adapter calls the same shape `AgentView`):

```ts
interface ConversationView {
  id: string;
  title: string;            // first line of the launch prompt, ≤ 80 chars
  status: "running" | "finished" | "failed" | "cancelled";
  runId: string;            // must match ^[A-Za-z0-9_-]+$ (Rakazo validates it)
  branch?: string;          // only once pushed
  prUrl?: string;
  error?: string;
  url?: string;             // conversation page `${APP_URL}/ui/conversations/:id`; only when APP_URL is set
}
```

Errors are `{ "code": ... }`, and Rakazo maps them as follows:

| Status | `code` | Rakazo's reaction |
| --- | --- | --- |
| 400 | `invalid` | Request rejected, not retried. |
| 404 | `not_found` | Agent gone, not retried. |
| 409 | `busy` | Follow-up refused; Rakazo observes the current run instead of resending. |
| 500 | `internal` | Generic failure. |
| 404 | `route_not_found` | Generic failure. |

### Semantics Rakazo relies on

- **Agent ids** are chosen by Rakazo: the first 32 hex chars of a SHA-256 of its idempotency key. Launch idempotency is what makes a lost launch response safe to resend.
- **Runs**: each launch or follow-up creates a new `runId`. Rakazo tracks follow-ups by `runId` and polls `GET /agents/:id/runs/:runId` (the alias), so old runs must stay readable.
- **Sessions**: runs use `--session-id <uuid>` until Claude has created the session (its `system/init` event), then `--resume <uuid>`, so context carries over. A run where Claude exits before creating it, e.g. refusing to start, leaves the next run to create it.
- **Repository work**: with `repository`, the agent works in its own clone on branch `agent/<first 12 chars of id>`. When a run finishes successfully, leftover changes are committed with the title as message, the branch is pushed, and with `openPr` one PR is opened (or the existing one reused) via `gh`. Failed or cancelled runs publish nothing.
- **Restarts**: a run that was `running` when the service stopped is reported as `failed` on the next start. Conversations live only in PostgreSQL (`DB_CONNECTION_STRING`); the checkouts in `RUNNER_DATA_DIR/work/` must survive restarts too.
- **Workspace lifecycle** (start on demand, retry later) is Rakazo's job, not this service's.
- **Lost follow-up responses**: upstream's poller never resends a follow-up blindly. It calls `GET /agents/:id` and treats a new `runId` as proof the follow-up was accepted. So the latest run must be visible as soon as `POST /agents/:id/runs` returns.
- **Cancel by run**: the poller cancels the run it is tracking. Cancelling an older, already-finished run must return that run unchanged and must not touch a newer one.
- **`expired`**: the interface also has an `expired` status (agent gone or archived). This service never reports it. Agents and checkouts are kept forever.

### Changing the contract

Additive changes (new optional response fields, new endpoints) are safe. Anything else — renaming fields, changing status codes or error codes, changing idempotency or cancel semantics, changing the branch naming — needs a matching change in Rakazo's `coder-cloud-agent.ts` and its tests. Update this file and `README.md` with any contract change.
