# claude-relay

A small HTTP service that runs headless Claude Code sessions inside a Coder workspace. [Rakazo](https://rakazo.com)'s `coder` [cloud agent provider](https://rakazo.com/docs/self-host-integrations/#cloud-coding-agents) talks to it through Coder's app proxy, so Claude Code uses whatever login the workspace has.

Each agent gets its own clone under the data directory and its own Claude Code session. Follow-ups resume that session. When a run finishes, the runner commits leftover changes, pushes the branch `agent/<id>`, and opens a pull request with `gh` if the launch asked for one.

## Run it

It has no dependencies. Node 22.18 or newer runs the TypeScript source directly:

```bash
node src/index.ts
```

| Variable | Default | |
| --- | --- | --- |
| `PORT` | `4115` | Listens on `127.0.0.1` only. |
| `RUNNER_DATA_DIR` | `~/.claude-code-runner` | Agent records, checkouts and run logs (`logs/<agent>/<run>.jsonl`). Keep it on the persistent home volume. |
| `CLAUDE_COMMAND` | `claude` | |
| `GH_COMMAND` | `gh` | |

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
npm test
```

See [AGENTS.md](AGENTS.md) for the contract with Rakazo.

## API

All bodies are JSON. Errors are `{ "code": "invalid" | "not_found" | "busy" | "internal" }`.

| | |
| --- | --- |
| `GET /health` | `{ ok: true }`. |
| `PUT /agents/:id` | `{ prompt, images?, repository?, openPr? }`. Creates the agent and its first run; repeating it returns the existing agent. |
| `GET /agents/:id` | The latest run. |
| `GET /agents/:id/runs/:runId` | A specific run. |
| `POST /agents/:id/runs` | `{ prompt, images? }`. Starts a follow-up; `409 busy` while a run is going. |
| `POST /agents/:id/runs/:runId/cancel` | Stops the run and returns once it has stopped. |

Each returns `{ id, title, status, runId, branch?, prUrl?, error? }` with `status` one of `running`, `finished`, `failed`, `cancelled`.
