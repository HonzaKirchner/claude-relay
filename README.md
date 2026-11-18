# claude-relay

A small HTTP service that runs headless Claude Code sessions inside a Coder workspace. [Rakazo](https://rakazo.com)'s `apify-remote-platform` [cloud agent provider](https://rakazo.com/docs/self-host-integrations/#cloud-coding-agents) talks to it through Coder's app proxy, so Claude Code uses whatever login the workspace has.

The workspace holds a git checkout per repository under one directory, `~/src` by default: `~/src/apify-core` for `https://github.com/apify/apify-core`. Every conversation (an "agent" in Rakazo and the API) works in the checkout of the repository its launch names, on its own branch `agent/<id>` and in its own Claude Code session. Follow-ups resume that session. The checkouts together are one platform, so one run goes at a time across all of them: a launch or follow-up while any run is going is refused with `409 busy` (`reason: "locked"`), not queued. When a run starts, its checkout goes on the conversation's branch and every other checkout on its default branch, brought up to the origin where that is a fast-forward, so what the workspace builds and serves is that conversation's work on top of the defaults. When a run finishes, the runner commits leftover changes, pushes the branch, and opens a pull request with `gh` if the launch asked for one. The checkout stays on that branch until the next run.

A launch with `repository: "no_repo"` is a task without a repository, such as a question: it runs in the directory itself, on no branch, switches no checkout, and commits, pushes and opens nothing. A launch for a repository that is not cloned under the directory (or cloned from somewhere else under that name) is refused with `400 invalid` (`reason: "no_checkout"`); someone has to clone it in the workspace. A failed or cancelled run leaves its changes in the checkout. Its own conversation goes on from them; every other request is refused with `409 busy` (`reason: "dirty"`) until someone commits, stashes or discards them, since no run starts while any checkout has uncommitted changes. The same goes for changes a person made in a checkout by hand.

## Run it

Node 22.18 or newer runs the TypeScript source directly. There is nothing to install to run it and no database: it keeps what it must remember in files.

```bash
npm start     # node --env-file-if-exists=.env src/index.ts
```

Settings come from the environment, or from `.env` when started with `npm start`. Variables already set in the environment take precedence over `.env`.

| Variable | Default | |
| --- | --- | --- |
| `PORT` | `4115` | Listens on `127.0.0.1` only. |
| `RUNNER_STATE_DIR` | `~/.claude-relay` | Where the service keeps what it remembers across a restart: each conversation's session, branch and runs (`conversations/<id>.json`) and each run's events (`events/<runId>.jsonl`). Outside every checkout, on a disk that survives restarts. |
| `RUNNER_SECRETS_DIR` | `~/.apix` | Where the secrets handed over `PUT /secrets` are kept, each in a file only the service's user can read: `claude-oauth-token`, `github-token`, `platform-token`, `platform-url`. Read again on start. |
| `RUNNER_WORKDIR` | `~/src` | The directory holding the checkouts, one per repository and named after it: the last segment of the repository URL without `.git`. Each needs an `origin` remote the workspace can fetch from and push to, and it must be that repository. The directory can also be one checkout itself: launches that name its repository, or none, work in it. The service exits if the directory does not exist; whether a repository is checked out is checked per launch. |
| `RUNNER_BASE_BRANCH` | the origin's default branch | What a new conversation's branch starts from, unless the launch names a `baseBranch`. |
| `CLAUDE_COMMAND` | `claude` | |
| `CLAUDE_MODEL` | Claude Code's default | The model every run uses, passed to `claude` as `--model`: an alias such as `opus` or `sonnet`, or a full model id. |
| `GH_COMMAND` | `gh` | |
| `LOG_LEVEL` | `info` | `debug`, `info`, `warn`, `error` or `silent`. At `info` the log shows one line per launch, follow-up, cancel, `claude` exit (turns, cost), push, PR and run end, plus every write request. `debug` adds the GET polls and each git/gh command. |

## Coder template

The workspace needs `claude` logged in, `git` with an identity and push access, `gh` logged in for pull requests, and every repository Rakazo may send cloned under `~/src` (or `RUNNER_WORKDIR`), each in a directory named after it. A repository cloned later is picked up by the next launch. Claude Code refuses `--dangerously-skip-permissions` as root, so run the workspace as a normal user.

Expose the runner as an app with the slug `claude` (Rakazo hard-codes this slug and calls it on Coder's path route, `/@owner/workspace/apps/claude/...`, which Coder serves for subdomain apps too unless path apps are disabled), shared with the owner only. The owner's Coder token is the only credential Rakazo needs:

```hcl
resource "coder_app" "claude" {
  agent_id  = coder_agent.main.id
  slug      = "claude"
  url       = "http://localhost:4115"
  share     = "owner"
  subdomain = false
  hidden    = true
}

resource "coder_script" "claude_relay" {
  agent_id     = coder_agent.main.id
  display_name = "claude-relay"
  run_on_start = true
  script       = "nohup node /opt/claude-relay/src/index.ts >/tmp/claude-relay.log 2>&1 &"
}
```

A stopped workspace is started by Rakazo on the next poll. Coder does not count a running agent as activity, so turn off autostop for this workspace or give it a long enough TTL; a run cut off by a stop is reported as failed.

## Development

You need Node from `.nvmrc`, `git`, and for real runs `claude` and `gh`. Put these settings in a `.env` in the repository root:

```
RUNNER_WORKDIR=./.data/src
RUNNER_STATE_DIR=./.data/state
RUNNER_SECRETS_DIR=./.data/secrets
LOG_LEVEL=debug
```

`RUNNER_WORKDIR` holds a clone of every repository Claude should work on, named after it (`git clone https://github.com/example/demo .data/src/demo`); a launch for a repository that is not there is refused.

```bash
npm install
npm run dev        # the service, restarted on every change
```

A real launch runs `claude` on your machine and spends tokens, and when it finishes it pushes the branch to the checkout's origin (and opens a PR with `openPr`).

Before finishing a change:

```bash
npm run check
npm test      # fake claude and gh, a local git origin; needs nothing else
```

See [AGENTS.md](AGENTS.md) for the contract with Rakazo and with `apify-remote-platform`.

### What it keeps, and what it does not

The service has no pages and no database. It takes tasks, messages for the run going and requests to stop, and reports on them. Conversations are kept and shown by `apify-remote-platform`, which fetches each run's events from `GET /conversations/:id/transcript` and stores them. What the service writes under `RUNNER_STATE_DIR` is only what it needs to go on after a restart.

`npm run db:init` does nothing. It is still there because the Coder template runs it before starting the service.

### Secrets

`PUT /secrets` takes `claudeToken`, `githubToken`, `platformToken` and `platformUrl` (any of them). Each is written to its file under `RUNNER_SECRETS_DIR`, readable only by the service's user, and the Claude and GitHub tokens are used by the next run without a restart: the service puts them into its own environment (`CLAUDE_CODE_OAUTH_TOKEN`, `GH_TOKEN`, and git configuration that makes `gh` git's credential for github.com), which every `claude`, `git` and `gh` it starts inherits. The answer says which are set, never what they are, and nothing reads them back. Only callers Coder lets through its app proxy, and processes inside the workspace, can reach the endpoint; every run can read the secrets, so scope the tokens accordingly.

## API

All bodies are JSON. Errors are `{ "code": "invalid" | "not_found" | "busy" | "not_running" | "internal" }`. A `busy` body also says why: `{ "reason": "locked", "conversation" }` when a run is going, in any conversation, naming whose; `{ "reason": "dirty", "branch", "path" }` when a checkout under `RUNNER_WORKDIR` has uncommitted changes that are not the conversation's own, naming the checkout and the branch it is on. An `invalid` body with `{ "reason": "no_checkout", "path", "repository"?, "found"? }` means the repository is not checked out at `path` (or `found`, another repository, is). Any other `invalid` body carries `detail`, a sentence saying what the request got wrong (`"prompt is blank"`), which the service also logs at warn.

Every `/conversations` path is also served under `/agents`, the name Rakazo uses for a conversation.

| | |
| --- | --- |
| `GET /health` | `{ ok: true }`. |
| `PUT /conversations/:id` | `{ prompt, images?, repository?, openPr?, baseBranch? }`. Creates the conversation and its first run in the checkout of `repository` (an https URL; `<RUNNER_WORKDIR>/<last segment>`, or `RUNNER_WORKDIR` itself when that is a checkout of it; without `repository`, `RUNNER_WORKDIR` must be a checkout; with `"no_repo"`, it runs in `RUNNER_WORKDIR` on no branch and publishes nothing), on a branch from `baseBranch` (default: `RUNNER_BASE_BRANCH`, else the origin's default branch); repeating it returns the existing conversation. `400 invalid` (`reason: "no_checkout"`) when the repository is not checked out there. `409 busy` while any run is going or any checkout has uncommitted changes. |
| `GET /conversations/:id` | The latest run. |
| `GET /conversations/:id/runs/:runId` | A specific run. |
| `POST /conversations/:id/runs` | `{ prompt, images? }`. Starts a follow-up in the conversation's checkout; `409 busy` while any run is going or any checkout has changes that are not this conversation's own; `400 invalid` (`reason: "no_checkout"`) when the checkout is gone. |
| `GET /conversations` | `{ conversations: [{ id, title, status, runCount, repository?, branch?, updatedAt }] }`: every conversation with its latest run's status, most recently active first. |
| `GET /conversations/:id/transcript?have=` | The whole conversation: every run with its events (the stream-json lines, each `{ at, event }`) and messages, the repository, branch and PR, and `composer`, what a message box for it can do right now. `have=<runId>:<count>,...` says how many of each run's events the caller already holds; those are left out, and each run's `firstEvent` says where its `events` begin. For `apify-remote-platform`, which keeps and shows conversations. |
| `GET /workspace` | `{ running?: { conversation, title, runId, startedAt, checkout? }, checkouts: [{ name, path, repository, branch, defaultBranch?, dirty, conversation? }] }`: the run going, and every checkout under `RUNNER_WORKDIR` with the branch it is on, its origin's default branch when the clone recorded it (`origin/HEAD`), whether it has uncommitted changes, and the conversation that branch belongs to. The checkout the service itself runs from is left out, even under the root, and so is `apify-dev-sandbox` (the dev sandbox's own repository, not part of the platform). What the pages' workspace section shows. |
| `GET /availability` | Whether a run could start right now, without starting one: `{ available: true }`, or `{ available: false, reason, ... }` with the reason and details the launch or follow-up would be refused with: `locked` (`conversation`, `title`: whose run is going) or `dirty` (`name`, `path`, `branch`: the checkout with uncommitted changes). `?conversation=<id>` asks for a follow-up of that conversation instead: its own leftovers do not count, `no_checkout` (`path`, `repository`) means its checkout is gone, and an unknown id is `404 not_found`. A moment's picture: the launch or follow-up is checked again when it comes. |
| `POST /conversations/:id/runs/:runId/cancel` | Stops the run and returns once it has stopped. |
| `POST /conversations/:id/runs/:runId/messages` | Steers a running run: `{ prompt, images? }` is stored and written to Claude's stdin, and Claude reads it at its next step. `409 not_running` once the run has ended or no longer takes messages. |
| `PUT /secrets` | `{ claudeToken?, githubToken?, platformToken?, platformUrl? }`. Stores the ones given and starts using them; answers which are set, as booleans. See "Secrets". |

Each returns `{ id, title, status, runId, latestRunId, branch?, prUrl?, error?, summary? }` with `status` one of `running`, `finished`, `failed`, `cancelled`. `runId` is the run described (the latest one, or the one asked for); `latestRunId` is always the conversation's latest run. `summary` is Claude's final answer for that run (the text of its last successful `result`, at most 20 000 characters, which is what Rakazo keeps); a failed run with no answer carries its `error` there too, since Rakazo shows only the summary.
