-- Schema for claude-relay's state (PostgreSQL). This database is the only place
-- conversations are stored; the service does not start without it.
--
-- Mirrors the relay's own model: a conversation owns one Claude session and
-- many runs; each run is one `claude --print --output-format stream-json`
-- process whose stdout lines become `events`. Tool calls are split out of
-- assistant events (tool_use blocks) and matched with their results
-- (tool_result blocks in a following user event).
--
-- Rakazo and the HTTP API call a conversation an "agent"; ids are the same.
--
-- Idempotent: safe to run again. The service applies it on start;
-- `npm run db:init` applies it by hand.

-- Databases created before the rename had `agents` and `messages`. Rename them
-- in place so their history is kept.
DO $$
BEGIN
  IF to_regclass('agents') IS NOT NULL AND to_regclass('conversations') IS NULL THEN
    ALTER TABLE agents RENAME TO conversations;
    ALTER TABLE runs RENAME COLUMN agent_id TO conversation_id;
  END IF;
  IF to_regclass('messages') IS NOT NULL AND to_regclass('events') IS NULL THEN
    ALTER TABLE messages RENAME TO events;
    ALTER TABLE tool_calls RENAME COLUMN message_id TO event_id;
    ALTER TABLE tool_calls RENAME COLUMN result_message_id TO result_event_id;
  END IF;
END $$;
ALTER INDEX IF EXISTS runs_agent_started_idx RENAME TO runs_conversation_started_idx;
ALTER INDEX IF EXISTS messages_session_idx RENAME TO events_session_idx;
ALTER INDEX IF EXISTS messages_api_message_idx RENAME TO events_api_message_idx;

CREATE TABLE IF NOT EXISTS conversations (
  id          text PRIMARY KEY,                -- Rakazo's agent id
  title       text NOT NULL,
  session_id  uuid NOT NULL UNIQUE,            -- Claude Code session id
  repository  text,
  branch      text,                            -- agent/<id>; see `pushed`
  open_pr     boolean NOT NULL DEFAULT false,
  session_started boolean NOT NULL DEFAULT false, -- Claude created the session; next run resumes it
  base_commit text,                            -- commit the branch started from
  pushed      boolean NOT NULL DEFAULT false,
  pr_url      text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE conversations ADD COLUMN IF NOT EXISTS pushed boolean NOT NULL DEFAULT false;
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS session_started boolean NOT NULL DEFAULT false;
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS base_commit text;

CREATE TABLE IF NOT EXISTS runs (
  id               text PRIMARY KEY,           -- relay run id
  conversation_id  text NOT NULL REFERENCES conversations (id) ON DELETE CASCADE,
  seq              integer NOT NULL,           -- 1 = launch, 2.. = follow-ups
  status           text NOT NULL
                   CHECK (status IN ('running', 'finished', 'failed', 'cancelled')),
  prompt           text NOT NULL,
  images           jsonb,                      -- request images as sent
  image_count      integer,
  error            text,
  stderr           text,                       -- tail of Claude Code's stderr
  model            text,                       -- from the system/init event
  claude_code_version text,
  -- Totals from the final `result` event.
  result_subtype   text,                       -- success | error_max_turns | ...
  result_text      text,
  is_error         boolean,
  num_turns        integer,
  duration_ms      integer,
  duration_api_ms  integer,
  total_cost_usd   numeric(12, 6),
  input_tokens                 bigint,
  output_tokens                bigint,
  cache_creation_input_tokens  bigint,
  cache_read_input_tokens      bigint,
  usage            jsonb,                      -- full usage / modelUsage objects
  started_at       timestamptz NOT NULL DEFAULT now(),
  finished_at      timestamptz,
  UNIQUE (conversation_id, seq)
);
ALTER TABLE runs ADD COLUMN IF NOT EXISTS image_count integer;
ALTER TABLE runs ADD COLUMN IF NOT EXISTS stderr text;
CREATE INDEX IF NOT EXISTS runs_conversation_started_idx ON runs (conversation_id, started_at DESC);
CREATE INDEX IF NOT EXISTS runs_status_idx ON runs (status) WHERE status = 'running';

-- One row per stream-json line (system, user, assistant, result, ...).
CREATE TABLE IF NOT EXISTS events (
  id                  bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  run_id              text NOT NULL REFERENCES runs (id) ON DELETE CASCADE,
  seq                 integer NOT NULL,        -- line order within the run
  type                text NOT NULL,           -- event `type`
  subtype             text,                    -- event `subtype`, if any
  uuid                uuid,                    -- Claude Code's event uuid
  session_id          uuid,
  parent_tool_use_id  text,                    -- set for sub-agent (Task) events
  role                text,                    -- message.role: user | assistant
  api_message_id      text,                    -- message.id (msg_...)
  model               text,
  stop_reason         text,
  content             jsonb,                   -- message.content blocks
  input_tokens                 integer,
  output_tokens                integer,
  cache_creation_input_tokens  integer,
  cache_read_input_tokens      integer,
  raw                 jsonb NOT NULL,          -- the full event, untouched
  created_at          timestamptz NOT NULL DEFAULT now(), -- when the runner received it
  UNIQUE (run_id, seq)
);
CREATE INDEX IF NOT EXISTS events_session_idx ON events (session_id, created_at);
CREATE INDEX IF NOT EXISTS events_api_message_idx ON events (api_message_id);

CREATE TABLE IF NOT EXISTS tool_calls (
  id                  text PRIMARY KEY,        -- tool_use id (toolu_...)
  run_id              text NOT NULL REFERENCES runs (id) ON DELETE CASCADE,
  event_id            bigint NOT NULL REFERENCES events (id) ON DELETE CASCADE,
  result_event_id     bigint REFERENCES events (id) ON DELETE SET NULL,
  parent_tool_use_id  text,                    -- set when called by a sub-agent
  name                text NOT NULL,           -- Bash, Edit, mcp__server__tool, ...
  input               jsonb NOT NULL,          -- arguments
  result              jsonb,                   -- tool_result content
  is_error            boolean,
  started_at          timestamptz NOT NULL DEFAULT now(),
  completed_at        timestamptz
);
CREATE INDEX IF NOT EXISTS tool_calls_run_idx ON tool_calls (run_id, started_at);
CREATE INDEX IF NOT EXISTS tool_calls_name_idx ON tool_calls (name);
