# claude-relay

A small HTTP service that runs headless Claude Code sessions inside a Coder workspace. [Rakazo](https://rakazo.com)'s `coder` [cloud agent provider](https://rakazo.com/docs/self-host-integrations/#cloud-coding-agents) talks to it through Coder's app proxy, so Claude Code uses whatever login the workspace has.

The workspace holds a git checkout per repository under one directory, `~/src` by default: `~/src/apify-core` for `https://github.com/apify/apify-core`. Every conversation (an "agent" in Rakazo and the API) works in the checkout of the repository its launch names, on its own branch `agent/<id>` and in its own Claude Code session. Follow-ups resume that session. A checkout is shared by every conversation of its repository, so one run goes at a time in it: a launch or follow-up while another run is going there is refused with `409 busy` (`reason: "locked"`), not queued. Runs in different repositories go side by side. When a run finishes, the runner commits leftover changes, pushes the branch, and opens a pull request with `gh` if the launch asked for one. The checkout stays on that branch, so what the workspace builds and serves from it is the latest conversation's work.

A launch for a repository that is not cloned under the directory (or cloned from somewhere else under that name) is refused with `400 invalid` (`reason: "no_checkout"`); someone has to clone it in the workspace. A failed or cancelled run leaves its changes in the checkout. Its own conversation goes on from them; any other request for that checkout is refused with `409 busy` (`reason: "dirty"`) until someone commits, stashes or discards them. The same goes for changes a person made in the checkout by hand.

## Run it

Node 22.18 or newer runs the TypeScript source directly. It needs a PostgreSQL database, the only place conversations are stored, and the `pg` package (`npm install`).

```bash
npm start     # node --env-file-if-exists=.env src/index.ts
```

Settings come from the environment, or from `.env` when started with `npm start`. Variables already set in the environment take precedence over `.env`.

| Variable | Default | |
| --- | --- | --- |
| `PORT` | `4115` | Listens on `127.0.0.1` only. |
| `DB_CONNECTION_STRING` | – (required) | PostgreSQL URL. Every conversation, run, event and tool call is stored there and nowhere else. The service applies the schema on start and exits if the variable is missing or the database is unreachable. |
| `RUNNER_WORKDIR` | `~/src` | The directory holding the checkouts, one per repository and named after it: the last segment of the repository URL without `.git`. Each needs an `origin` remote the workspace can fetch from and push to, and it must be that repository. The directory can also be one checkout itself: launches that name its repository, or none, work in it. The service exits if the directory does not exist; whether a repository is checked out is checked per launch. |
| `RUNNER_BASE_BRANCH` | the origin's default branch | What a new conversation's branch starts from, unless the launch names a `baseBranch`. |
| `CLAUDE_COMMAND` | `claude` | |
| `CLAUDE_MODEL` | Claude Code's default | The model every run uses, passed to `claude` as `--model`: an alias such as `opus` or `sonnet`, or a full model id. |
| `GH_COMMAND` | `gh` | |
| `APP_URL` | – | The service's base URL in a browser, e.g. `https://coder.example.com/@owner/workspace/apps/claude`. When set, responses include `url`, a link to the conversation page. |
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

You need Node from `.nvmrc` and Docker. Put these settings in a `.env` in the repository root:

```
DB_CONNECTION_STRING=postgres://postgres:dev@127.0.0.1:5432/claude_relay
RUNNER_WORKDIR=./.data/src
APP_URL=http://127.0.0.1:4115
LOG_LEVEL=debug
```

`RUNNER_WORKDIR` holds a clone of every repository Claude should work on, named after it (`git clone https://github.com/example/demo .data/src/demo`); a launch for a repository that is not there is refused. Without the variable the service looks in `~/src`, and refuses to start if that does not exist.

Then:

```bash
npm install
npm run db:start   # PostgreSQL in Docker, matching DB_CONNECTION_STRING
npm run db:seed    # optional: a few sample conversations
npm run dev        # db:start, then the service, restarted on every change
```

Open <http://127.0.0.1:4115/ui/conversations>. A real launch runs `claude` on your machine and spends tokens, and when it finishes it pushes the branch to the checkout's origin (and opens a PR with `openPr`). Point `CLAUDE_COMMAND` and `GH_COMMAND` at stubs to avoid that.

| Script | |
| --- | --- |
| `npm run dev` | Starts the database, then the service with `node --watch`. |
| `npm run db:start` | Creates or starts the `claude-relay-pg` container and waits until it accepts connections. The user, password, database and port come from `DB_CONNECTION_STRING`. Its data is kept in the `claude-relay-pg-data` volume. |
| `npm run db:stop` | Stops the container and keeps its data. |
| `npm run db:reset` | Deletes the container and its data, then starts an empty one. |
| `npm run db:seed` | Adds six sample conversations (ids starting with `seed-`): every finished status, a follow-up, tool calls, a steering message, a PR, and a long engineering run with 29 tool calls. Existing ones are skipped. |

Before finishing a change:

```bash
npm run check
npm test      # needs PostgreSQL: Docker, or TEST_DATABASE_URL
```

The tests store conversations in a throwaway database. Without `TEST_DATABASE_URL` they start a `postgres:16-alpine` container with Docker. With it, they create and later drop a `claude_relay_test_<pid>` database on that server, leaving everything else there alone.

See [AGENTS.md](AGENTS.md) for the contract with Rakazo.

### Database

The tables are `conversations`, `runs`, `events` and `tool_calls`; see [`db/schema.sql`](db/schema.sql). The service creates or updates them on start, and `npm run db:init` does the same by hand. It is idempotent, and renames the tables of a database created under the old names (`agents`, `messages`).

Older versions kept conversations in files under a data directory (`RUNNER_DATA_DIR`: `agents/*.json`, `logs/*/*.jsonl`). The service no longer reads them. `npm run db:import` copies them into the database once: conversations already there are skipped, the files are left untouched, and imported events carry their run's start time. Delete `agents/` and `logs/` afterwards.

Older versions also gave each conversation a clone of its own under that directory (`work/<id>`). Those are not used any more: a follow-up on such a conversation fetches its branch from the origin if it was pushed, and otherwise starts the branch again from the base. The clones can be deleted.

## API

All bodies are JSON. Errors are `{ "code": "invalid" | "not_found" | "busy" | "not_running" | "internal" }`. A `busy` body also says why: `{ "reason": "locked", "conversation" }` when a run is going in the checkout, in any conversation, naming whose; `{ "reason": "dirty", "branch" }` when the checkout has uncommitted changes that are not the conversation's own, naming the branch it is on. An `invalid` body with `{ "reason": "no_checkout", "path", "repository"?, "found"? }` means the repository is not checked out at `path` (or `found`, another repository, is).

Every `/conversations` path is also served under `/agents`, the name Rakazo uses for a conversation.

| | |
| --- | --- |
| `GET /health` | `{ ok: true }`. |
| `PUT /conversations/:id` | `{ prompt, images?, repository?, openPr?, baseBranch? }`. Creates the conversation and its first run in the checkout of `repository` (an https URL; `<RUNNER_WORKDIR>/<last segment>`, or `RUNNER_WORKDIR` itself when that is a checkout of it; without `repository`, `RUNNER_WORKDIR` must be a checkout), on a branch from `baseBranch` (default: `RUNNER_BASE_BRANCH`, else the origin's default branch); repeating it returns the existing conversation. `400 invalid` (`reason: "no_checkout"`) when the repository is not checked out there. `409 busy` while a run is going in that checkout or it has uncommitted changes. |
| `GET /conversations/:id` | The latest run. |
| `GET /conversations/:id/runs/:runId` | A specific run. |
| `POST /conversations/:id/runs` | `{ prompt, images? }`. Starts a follow-up in the conversation's checkout; `409 busy` while a run is going there or it has changes that are not this conversation's own; `400 invalid` (`reason: "no_checkout"`) when the checkout is gone. |
| `POST /conversations/:id/runs/:runId/cancel` | Stops the run and returns once it has stopped. |
| `POST /conversations/:id/runs/:runId/messages` | Steers a running run: `{ prompt, images? }` is stored and written to Claude's stdin, and Claude reads it at its next step. `409 not_running` once the run has ended or no longer takes messages. |

Each returns `{ id, title, status, runId, latestRunId, branch?, prUrl?, error?, summary?, url? }` with `status` one of `running`, `finished`, `failed`, `cancelled`. `runId` is the run described (the latest one, or the one asked for); `latestRunId` is always the conversation's latest run. `summary` is Claude's final answer for that run (the text of its last successful `result`, at most 20 000 characters, which is what Rakazo keeps); a failed run with no answer carries its `error` there too, since Rakazo shows only the summary. `url` is present only when `APP_URL` is set and points to `GET /ui/conversations/:id`, an HTML page with the whole conversation (all runs). The page follows `GET /ui/conversations/:id/stream` (server-sent events): Claude's events appear as they are printed, a line under the run says what Claude is doing right now and for how long, and the page refreshes itself when a run starts or ends. While a run goes, a message box at the bottom of the page steers it. Its left sidebar lists every conversation; `GET /ui/conversations` shows that list on its own.
