# claude-relay

A small HTTP service that runs headless Claude Code sessions inside a Coder workspace. [Rakazo](https://rakazo.com)'s `coder` [cloud agent provider](https://rakazo.com/docs/self-host-integrations/#cloud-coding-agents) talks to it through Coder's app proxy, so Claude Code uses whatever login the workspace has.

Each conversation (an "agent" in Rakazo and the API) gets its own clone under the data directory and its own Claude Code session. Follow-ups resume that session. When a run finishes, the runner commits leftover changes, pushes the branch `agent/<id>`, and opens a pull request with `gh` if the launch asked for one.

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
| `RUNNER_DATA_DIR` | `~/.claude-code-runner` | Only the git checkouts Claude works in (`work/<id>`), no conversation data. Keep it on the persistent home volume so follow-ups find their checkout. |
| `CLAUDE_COMMAND` | `claude` | |
| `GH_COMMAND` | `gh` | |
| `APP_URL` | – | The service's base URL in a browser, e.g. `https://coder.example.com/@owner/workspace/apps/claude-code-runner`. When set, responses include `url`, a link to the conversation page. |
| `LOG_LEVEL` | `info` | `debug`, `info`, `warn`, `error` or `silent`. At `info` the log shows one line per launch, follow-up, cancel, `claude` exit (turns, cost), push, PR and run end, plus every write request. `debug` adds the GET polls and each git/gh command. |

## Coder template

The workspace needs `claude` logged in, `git` with an identity and push access, and `gh` logged in for pull requests. Claude Code refuses `--dangerously-skip-permissions` as root, so run the workspace as a normal user.

Expose the runner as a path-based app with the slug `claude-code-runner` (Rakazo hard-codes this slug), shared with the owner only. The owner's Coder token is the only credential Rakazo needs:

```hcl
resource "coder_app" "claude_code_runner" {
  agent_id  = coder_agent.main.id
  slug      = "claude-code-runner"
  url       = "http://localhost:4115"
  share     = "owner"
  subdomain = false
  hidden    = true
}

resource "coder_script" "claude_code_runner" {
  agent_id     = coder_agent.main.id
  display_name = "Claude Code runner"
  run_on_start = true
  script       = "nohup node /opt/claude-relay/src/index.ts >/tmp/claude-code-runner.log 2>&1 &"
}
```

A stopped workspace is started by Rakazo on the next poll. Coder does not count a running agent as activity, so turn off autostop for this workspace or give it a long enough TTL; a run cut off by a stop is reported as failed.

## Development

```bash
npm install
npm run check
npm test      # needs PostgreSQL: Docker, or TEST_DATABASE_URL
```

The tests store conversations in a throwaway database. Without `TEST_DATABASE_URL` they start a `postgres:16-alpine` container with Docker. With it, they create and later drop a `claude_relay_test_<pid>` database on that server, leaving everything else there alone.

See [AGENTS.md](AGENTS.md) for the contract with Rakazo.

### Database

The tables are `conversations`, `runs`, `events` and `tool_calls`; see [`db/schema.sql`](db/schema.sql). The service creates or updates them on start, and `npm run db:init` does the same by hand. It is idempotent, and renames the tables of a database created under the old names (`agents`, `messages`).

Older versions kept conversations in files under `RUNNER_DATA_DIR` (`agents/*.json`, `logs/*/*.jsonl`). The service no longer reads them. `npm run db:import` copies them into the database once: conversations already there are skipped, the files are left untouched, and imported events carry their run's start time. Delete `agents/` and `logs/` afterwards.

## API

All bodies are JSON. Errors are `{ "code": "invalid" | "not_found" | "busy" | "internal" }`.

Every `/conversations` path is also served under `/agents`, the name Rakazo uses for a conversation.

| | |
| --- | --- |
| `GET /health` | `{ ok: true }`. |
| `PUT /conversations/:id` | `{ prompt, images?, repository?, openPr? }`. Creates the conversation and its first run; repeating it returns the existing conversation. |
| `GET /conversations/:id` | The latest run. |
| `GET /conversations/:id/runs/:runId` | A specific run. |
| `POST /conversations/:id/runs` | `{ prompt, images? }`. Starts a follow-up; `409 busy` while a run is going. |
| `POST /conversations/:id/runs/:runId/cancel` | Stops the run and returns once it has stopped. |

Each returns `{ id, title, status, runId, branch?, prUrl?, error?, url? }` with `status` one of `running`, `finished`, `failed`, `cancelled`. `url` is present only when `APP_URL` is set and points to `GET /ui/conversations/:id`, an HTML page with the whole conversation (all runs) that reloads every 5 s while a run is going.
