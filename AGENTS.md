# AGENTS.md

Guidance for coding agents working in this repository.

## What this is

`claude-relay` is a small HTTP service that runs headless Claude Code (`claude --print`) sessions inside a Coder workspace, so `claude` can be driven from outside the workspace through Coder's app proxy. It is only meant to run inside a Coder workspace: Coder handles authentication, so the service itself has none and listens on loopback only.

Its primary consumer is [Rakazo](https://rakazo.com)'s **Cloud Agent** integration ([docs](https://rakazo.com/docs/self-host-integrations/#cloud-coding-agents)). The service was extracted from `infra/claude-code-runner` in the fork <https://github.com/HonzaKirchner/rakazo> (commit `951f012`, "coder runner"). **Upstream [elie222/rakazo](https://github.com/elie222/rakazo) has neither the runner nor an `apify-remote-platform` provider**: upstream only knows the `cursor` and `emulator` providers, and treats any other `CLOUD_AGENT_PROVIDER` value as `none`. Upstream rakazo can only reach this service through the fork's `apify-remote-platform` adapter.

## Terminology

| Term | Meaning |
| --- | --- |
| **conversation** | One Claude Code session with its own branch and PR in the checkout of its repository. Created by a launch, extended by follow-ups. Rakazo calls it an **agent**: the HTTP API also answers under `/agents/:id` for Rakazo, and the `agent/<id>` branch keeps that name. |
| **root** | The directory (`RUNNER_WORKDIR`, default `~/src`) holding the checkouts, one per repository and named after it (`~/src/apify-core` for `https://github.com/apify/apify-core`). It may also be one checkout itself. |
| **checkout** | The git checkout under the root a conversation works in: that of the repository its launch named. Shared by every conversation of that repository. |
| **workspace** | The checkouts under the root together, which make up one platform (one Coder workspace builds and serves all of them). One run at a time across it; `GET /workspace` describes it. |
| **run** | One prompt sent to the conversation: one `claude --print` process with its own `runId` and status. |
| **event** | One stream-json line a run printed (`system`, `assistant`, `user`, `result`, ...). |
| **tool call** | A `tool_use` block from an assistant event, paired with its `tool_result`. |

Use these names in code and in what is stored; use "agent" only where Rakazo's contract requires it.

## Layout

| File | Role |
| --- | --- |
| `src/index.ts` | Entry point: reads env, loads state, listens on `127.0.0.1:$PORT`. |
| `src/http.ts` | Routing, request validation, error → status mapping. |
| `src/runner.ts` | `ConversationRunner`: the checkouts under the root and the one lock over them, per-conversation branches, the `claude` process and steering it, commit/push/PR, the workspace scan. |
| `src/secrets.ts` | `SecretStore`: the tokens the service is handed over `PUT /secrets`, kept as files only it can read and put into the environment its runs inherit. |
| `src/store.ts` | `Store`: what the service remembers across a restart, as files in one directory (`RUNNER_STATE_DIR`, default `~/.claude-relay`): `conversations/<id>.json` and `events/<runId>.jsonl`. |
| `src/log.ts` | One-line `key=value` logger, filtered by `LOG_LEVEL`. |
| `src/runner.test.ts` | End-to-end tests over HTTP with fake `claude` and `gh` scripts and a local git origin. Needs nothing but git and node. |
| `scripts/db-init.ts` | Does nothing. The Coder template runs `npm run db:init` before it starts the service and will not start it if that fails, so the script stays until the template stops calling it. |

## Commands

Node ≥ 22.18 runs the TypeScript source directly (type stripping); there is no build step.

```bash
npm install      # dev deps only: typescript, vitest, @types/node
npm run check    # tsc --noEmit
npm test         # vitest; needs only git and node
npm start        # node src/index.ts
npm run dev      # the service with --watch
```

Run `npm run check` and `npm test` before finishing any change.

In an apix dev sandbox, [`apix.yaml`](apix.yaml) defines the `relay` service and the `test` and `check` tasks. Node comes from `.nvmrc`. If you rename the startup log line in `src/index.ts`, also update `ready_when` in `apix.yaml`.

## Code rules

- **No runtime dependencies.** Everything in `src/` uses only `node:` built-ins. Do not add runtime dependencies; dev dependencies are fine.
- Only erasable TypeScript (`erasableSyntaxOnly`): no enums, namespaces or parameter properties. Import local files with the `.ts` extension.
- Child processes are spawned `detached` and stopped by process group, so cancel also kills anything `claude` started. Keep that when adding commands; route them through `AgentRunner.exec` so cancel can reach them.
- Log through `src/log.ts` (`log.info(message, { conversation, run, ... })`), not `console`. Never log prompts or tokens. Keep the `claude-code-runner listening on` startup line: apix's `ready_when` matches it.
- **It does three things and keeps what they need.** Take a task (a launch, or a follow-up), take messages for the run going, stop a run; and report on them: a run's state, the conversation with its events, the checkouts. It has no pages, no database and no history of its own to show: `apify-remote-platform` fetches the events (`GET /conversations/:id/transcript?have=`) and is where conversations are kept and read. What the service must remember to do its part (each conversation's session, branch and runs, and each run's events) goes through `Store` to files under `RUNNER_STATE_DIR`, never into a checkout. Store a launch or follow-up before starting it, and fail the request if that write fails. Do not add pages, a database, or anything that only serves showing a conversation: that belongs to the platform.
- **Secrets come over `PUT /secrets`, stay in files, and are never given back.** `SecretStore` writes each to a file of mode 600 under `RUNNER_SECRETS_DIR` (`~/.apix`, where the Coder template reads `claude-oauth-token` and `github-token` on every start) and puts the Claude and GitHub tokens into the service's own environment, which every `claude`, `git` and `gh` it starts inherits, so they apply to the next run without a restart. The platform's token and URL are kept out of the environment: a run has no use for them. Never log a secret, quote one in an error, or add a route that returns one. Every run can read the files and its environment anyway (same user, `--dangerously-skip-permissions`), so the tokens must be scoped for that.
- **One checkout per repository, one run at a time across all of them.** The checkouts under the root are one platform, so the runner holds one lock (`current`) and refuses, never queues, a run while another is going anywhere or while any checkout is dirty (unless the changes are the conversation's own, in its checkout on its branch). Take the lock synchronously, before anything awaits, and release it only once the run has ended (`release`). Every run works in the checkout of the conversation's repository (`locate`, derived from the stored `repository` on every run, never stored itself) on the conversation's branch, and puts every other checkout on its default branch (`prepareOther`). Never clone, and never write to a checkout outside a run: `workspace` only reads (branch, `status --porcelain`, `origin/HEAD`), through `read`, not `exec`. A checkout named in `IGNORED_CHECKOUTS` (`claude-relay`, `apify-dev-sandbox`: the workspace's tooling) is no part of the platform, and neither is the checkout the service itself runs from, whatever its name (`OWN_CHECKOUT`): `scan` leaves them out, so they are never listed, switched, or counted as dirty.

## The Rakazo Cloud Agent contract

The contract has two layers:

1. **Provider-neutral, owned by upstream rakazo.** This is the `CloudAgentProvider` interface (`packages/adapter-kit/src/interfaces.ts`, types in `types.ts`, errors in `cloud-agents.ts`). The behaviour core relies on lives in `packages/adapters/src/cloud-agent-poll.ts`, and `cloud-agent-conformance.test.ts` and the Cursor adapter serve as the reference. See "Semantics Rakazo relies on" below.
2. **HTTP wire format, owned by the fork's adapter** `packages/adapters/src/apify-remote-platform-cloud-agent.ts` (`ApifyRemotePlatformCloudAgentProvider`). It maps the interface onto the endpoints below. Check that adapter before changing anything observable here.

### Transport

- Rakazo reaches the service through Coder's app proxy at `/@<owner>/<workspace>/apps/claude/<path>`, authenticated by the workspace owner's Coder token. The app slug **`claude` is hard-coded in Rakazo** (`APP_SLUG` in `apify-remote-platform-cloud-agent.ts`; it was `claude-code-runner` before the fork's commit `51840fb`). The adapter builds the conversation page link itself from that path, so `url` in responses is for other callers.
- `apify-remote-platform` is a second caller of the same contract: Rakazo's adapter can send every agent to it instead, and it passes each request on to the relay of the workspace it chose, under the canonical `/conversations` paths, through the same app proxy. What Rakazo relies on below therefore holds for requests that arrive that way too; the platform reads `code: "busy"` itself, to try another workspace.
- The service itself does no authentication and listens on loopback only, by design: it runs only inside a Coder workspace. Do not add a non-loopback listener without adding authentication.
- Rakazo treats a non-JSON or code-less error response as "workspace not reachable" and starts the workspace. So **every response from this service must be JSON**, and every error must carry a `code`.
- Rakazo reads at most 1 MB of a response and times out requests after 30 s.

### Endpoints

All bodies are JSON. `:id` and `:runId` match `[A-Za-z0-9_-]{1,128}`.

The canonical paths start with `/conversations`. Every one of them is also served under `/agents` (`/agents/:id`, `/agents/:id/runs`, ...), with identical behaviour. **The fork's `apify-remote-platform` adapter calls the `/agents` paths, so they must keep working** until it moves to `/conversations`.

| Method & path | Body | Behaviour |
| --- | --- | --- |
| `GET /health` | – | `{ "ok": true }` |
| `PUT /conversations/:id` | `LaunchRequest` | Creates the conversation and its first run in the checkout of `repository`. **Idempotent**: repeating it with the same id returns the existing conversation's latest run and starts nothing. `400 invalid` with `reason: "no_checkout"` when the repository is not checked out under the root (see "The checkout"); `409 busy` while any run is going (`reason: "locked"`) or while any checkout has uncommitted changes (`reason: "dirty"`); none of these creates the conversation. With `repository: "no_repo"` the conversation has no checkout: it runs in the root and is never refused with `no_checkout` (see "The checkout"). |
| `GET /conversations/:id` | – | Latest run. |
| `GET /conversations/:id/runs/:runId` | – | A specific run. |
| `POST /conversations/:id/runs` | `PromptRequest` | Starts a follow-up that resumes the same Claude session, in the conversation's checkout. `409 busy` while any run is going (`locked`), or while any checkout has uncommitted changes that are not this conversation's own (`dirty`); `400 invalid` (`no_checkout`) when the checkout is gone. Also what the platform's message box sends when nothing runs. |
| `GET /conversations` | – | `{ conversations: ConversationSummary[] }`: every conversation with its latest run's status (`id`, `title`, `status`, `runCount`, `repository?`, `branch?`, `updatedAt`), most recently active first (`ConversationRunner.list`, what the pages' list shows). Additive; `apify-remote-platform` calls it, with `GET /workspace`, to show a workspace from outside. Rakazo never calls it. |
| `GET /conversations/:id/transcript?have=` | – | The whole conversation (`Transcript`): `id`, `title`, `repository?`, `branch?`, `pushed`, `prUrl?`, every run in order (`seq`, `id`, `status`, `prompt`, `imageCount?`, `error?`, `stderr?`, `startedAt`, `finishedAt?`, `messages?`, `firstEvent`, and `events`: each `{ at, event }`, the stream-json lines as Claude printed them), and `composer`, what a message box for it can do right now (`steer` with `runId`, `reply`, or `off` with the reason). `have=<runId>:<count>,...` says how many of each run's events the caller already holds: those are left out and `firstEvent` says where `events` begin, so a caller that keeps what it gets receives every event once (`400 invalid` when malformed). `apify-remote-platform` calls it to keep and show conversations. Rakazo never calls it. |
| `GET /workspace` | – | The run going and every checkout under the root with its branch (`Workspace`). `apify-remote-platform` calls it to show a workspace. Rakazo never calls it. |
| `GET /availability?conversation=` | – | Whether a run could start right now (`Availability`): `{ available: true }`, or `{ available: false }` plus the `reason` and details the refusal would carry (`locked` with `conversation` and `title`, `dirty` with `name`, `path` and `branch`). Without `conversation` it asks about any run at all, without looking for a checkout; with one, about a follow-up of that conversation (`404 not_found` when unknown; its own leftovers do not count; `no_checkout` with `path` and `repository` when its checkout is gone). Decided by `ConversationRunner.refusal`, the same check `acquire` and the page's message box use, over a fresh scan; it reads only and takes no lock, so the answer is a moment's picture. Additive; Rakazo does not call it yet. |
| `POST /conversations/:id/runs/:runId/cancel` | `{}` | Stops the run and **responds only once it has stopped**, with the final state. Cancelling a finished run returns it unchanged. |
| `POST /conversations/:id/runs/:runId/messages` | `PromptRequest` | Steers the running run: stores the message with the run, then writes it to `claude`'s stdin. `409 not_running` if the run is not going, was cancelled, or Claude has answered everything and the run is publishing. Sent by the platform's message box; Rakazo never calls it. |
| `PUT /secrets` | `Secrets` | Takes any of `claudeToken`, `githubToken`, `platformToken`, `platformUrl` (each a single line of at most 4096 characters; one left out stays as it was), stores them and starts using them (see "Code rules"). Answers which are set, as booleans, never the values. There is no `GET`. `apify-remote-platform` sends them each time the workspace comes up. Rakazo never calls it. |

```ts
type Image = { data: string; mimeType: "image/png" | "image/jpeg" | "image/gif" | "image/webp" } | { url: string };
interface PromptRequest { prompt: string /* non-blank, ≤ 100 000 chars */; images?: Image[] /* ≤ 5 */ }
interface LaunchRequest extends PromptRequest {
  repository?: string;  // https URL naming the checkout to work in (see "The checkout"), or "no_repo": Rakazo's adapter sends that when the task has none
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
}
```

Errors are `{ "code": ... }`, and Rakazo maps them as follows:

| Status | `code` | Rakazo's reaction |
| --- | --- | --- |
| 400 | `invalid` | Request rejected, not retried. The body adds, additively, `reason: "no_checkout"` with `path` (where the checkout was looked for), `repository` (when the launch named one) and `found` (the repository checked out there instead, if any) when the repository is not cloned under the root: someone has to clone it in the workspace, and Rakazo has to launch again. For a request that fails validation it adds `detail`, a sentence saying what is wrong (`"prompt is blank"`, `"repository \"x\" is not an https URL"`); the same sentence is logged at warn as `request rejected`, since Rakazo shows nothing of a rejected request. Never the prompt itself. |
| 404 | `not_found` | Agent gone, not retried. |
| 409 | `busy` | Launch or follow-up refused. Rakazo observes the current run instead of resending. The body adds, additively, `reason`: `locked` (a run is going, and `conversation` names whose) or `dirty` (a checkout has uncommitted changes that are not the conversation's own; `path` names the checkout and `branch` the branch it is on; someone has to commit, stash or discard them in the workspace). **Check**: Rakazo's adapter handled `busy` only for a follow-up of the running conversation; a launch, or a follow-up of an idle conversation, refused because *another* conversation runs or a checkout is dirty is new to it, and with one run at a time across the root, and follow-ups started from the platform's page, it happens more. |
| 409 | `not_running` | Steering message refused (only `POST .../messages`, which Rakazo does not call). |
| 500 | `internal` | Generic failure. |
| 404 | `route_not_found` | Generic failure. |

### Semantics Rakazo relies on

- **Agent ids** are chosen by Rakazo: the first 32 hex chars of a SHA-256 of its idempotency key. Launch idempotency is what makes a lost launch response safe to resend.
- **Runs**: each launch or follow-up creates a new `runId`. Rakazo tracks follow-ups by `runId` and polls `GET /agents/:id/runs/:runId` (the alias), so old runs must stay readable.
- **What Rakazo shows**: of a view it reads only `id`, `title`, `status`, `runId`, `branch`, `prUrl` and `summary` (`agentSchema` in the adapter); `error` and `latestRunId` are ignored. Its card and its `cloud_agent_status` tool show `summary` as the run's outcome, and it stores up to 20 000 characters of it. A new run must come with no summary (the previous reply must not linger), and a failed run carries its `error` as the summary so the failure is visible in Rakazo. Rakazo writes its own title from the prompt; ours is a fallback.
- **Sessions**: runs use `--session-id <uuid>` until Claude has created the session (its `system/init` event), then `--resume <uuid>`, so context carries over. A run where Claude exits before creating it, e.g. refusing to start, leaves the next run to create it.
- **The checkout**: every conversation works in the checkout of its repository under the root (`RUNNER_WORKDIR`), on branch `agent/<first 12 chars of id>`. The launch's `repository` picks it: `<root>/<name>`, `name` being the last segment of the URL without `.git` (`checkoutName`), and it must have that repository as its origin (compared without case, `.git` or a trailing slash), so a clone of something else under that name is refused. When the root itself is a checkout of the repository, it is used instead (a workspace with one checkout). A launch without `repository` works in the root, which must then be a checkout, and records its origin as the conversation's repository. Anything else is refused with `invalid` / `no_checkout`, as is a follow-up whose checkout is gone; nothing is ever cloned. A launch whose `repository` is the literal `"no_repo"` (`NO_REPOSITORY`; the fork's adapter sends it for a task that names no repository, such as a question) has no checkout: its runs work in the root whatever it is, on no branch, switch no checkout (the checkouts stay the last run's picture), and commit, push and open nothing, so its views never carry `branch` or `prUrl` and `openPr` is ignored. The one run at a time and the refusal while any checkout is dirty hold for it too. A new conversation's branch is fetched and created from `baseBranch`, else `RUNNER_BASE_BRANCH`, else the origin's default branch. Each run first puts the checkout on the conversation's branch (restoring it from the origin if the checkout lost it and it was pushed, else starting again from the base), and every other checkout under the root on its default branch (`origin/HEAD`, else asked from the origin), fast-forwarded to the origin where possible: a diverged default branch, or one whose origin cannot be reached, is left as it is with a warning, and only failing to switch fails the run. When a run finishes successfully, leftover changes are committed with the title as message, the branch is pushed, and with `openPr` one PR is opened (or the existing one reused) via `gh`. Failed or cancelled runs publish nothing and leave their changes in the checkout: the same conversation goes on from them, every other request is refused with `busy` (`reason: "dirty"`) until someone deals with them.
- **One run at a time across the root**: the checkouts together are one platform, so a launch or follow-up while any run is going is refused with `busy` (`reason: "locked"`), whichever repository either works in; nothing is queued. While nothing runs, the checkouts are the last run's picture: its conversation's branch in its checkout, the default branch everywhere else, so what the workspace builds and serves is that conversation's work on top of the defaults.
- **Follow-ups from the page**: the platform's message box starts follow-ups (`POST /conversations/:id/runs`) when nothing runs, so Rakazo can meet runs it did not start: `GET /agents/:id` may show a newer `runId` than the one it tracks, and a follow-up of its own may be refused with `busy`. Both are within what its poller does (it observes the running run). Only a Rakazo follow-up whose response was lost at the very moment a page follow-up started would be taken for that run.
- **Restarts**: a run that was `running` when the service stopped is reported as `failed` on the next start. What the service remembers lives in files under `RUNNER_STATE_DIR`, on the workspace's persistent disk; the checkouts must survive restarts too, with the conversations' branches in them. At start only the root is checked to exist; checkouts are checked per run.
- **Workspace lifecycle** (start on demand, retry later) is Rakazo's job, not this service's.
- **Lost follow-up responses**: upstream's poller never resends a follow-up blindly. It calls `GET /agents/:id` and treats a new `runId` as proof the follow-up was accepted. So the latest run must be visible as soon as `POST /agents/:id/runs` returns.
- **Steering**: `claude`'s stdin stays open after the prompt so messages can be written to it mid-run. It is closed once Claude has printed a `result` for every message written; if Claude merged a mid-turn message into the turn it was on, results stay behind, so stdin is also closed after `STEER_IDLE_MS` without output following a `result`. Closing stdin is what makes `claude --print` exit, so keep both rules.
- **Cancel by run**: the poller cancels the run it is tracking. Cancelling an older, already-finished run must return that run unchanged and must not touch a newer one.
- **`expired`**: the interface also has an `expired` status (agent gone or archived). This service never reports it. Agents and their branches are kept forever.

### Changing the contract

Additive changes (new optional response fields, new endpoints) are safe. Anything else — renaming fields, changing status codes or error codes, changing idempotency or cancel semantics, changing the branch naming — needs a matching change in Rakazo's `apify-remote-platform-cloud-agent.ts` and its tests. Update this file and `README.md` with any contract change.
