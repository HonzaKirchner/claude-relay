import { readFile } from "node:fs/promises";
import pg from "pg";
import { log } from "./log.ts";

/** One stdout line of `claude --output-format stream-json`, parsed. */
export type ClaudeEvent = Record<string, unknown>;

export type RunStatus = "running" | "finished" | "failed" | "cancelled";

export interface StoredEvent {
  /** When the runner received the line. */
  at: string;
  event: ClaudeEvent;
}

/** A message sent to a run while it was going, to steer it. */
export interface RunMessage {
  id: string;
  prompt: string;
  imageCount?: number;
  sentAt: string;
}

export interface Run {
  id: string;
  status: RunStatus;
  prompt: string;
  imageCount?: number;
  error?: string;
  /** The tail of what Claude Code wrote to stderr. */
  stderr?: string;
  startedAt: string;
  finishedAt?: string;
  /** The text of Claude's last successful `result`: its answer, shown to Rakazo as the summary. */
  summary?: string;
  /** Messages sent while it was going, oldest first. */
  messages?: RunMessage[];
}

export interface Conversation {
  id: string;
  title: string;
  sessionId: string;
  /** Whether Claude has created the session yet, so the next run must `--resume` it. */
  sessionStarted: boolean;
  repository?: string;
  openPr: boolean;
  branch?: string;
  baseCommit?: string;
  pushed: boolean;
  prUrl?: string;
  /** Oldest first; a run's seq is its position + 1. */
  runs: Run[];
}

const SCHEMA = new URL("../db/schema.sql", import.meta.url);

/**
 * The service's only persistent state: conversations, runs, every stream-json event, and tool
 * calls paired with their results, in PostgreSQL.
 *
 * Writes for one conversation are applied in order. Conversation and run writes return a
 * promise that rejects if the write failed, so callers can refuse to go on without it.
 * Event writes are fire-and-forget (a run produces many); `flush` waits for them.
 */
export class Store {
  private readonly pool: pg.Pool;
  private readonly queues = new Map<string, Promise<void>>();
  private closed = false;

  constructor(connectionString: string) {
    this.pool = new pg.Pool({ connectionString, max: 5, idleTimeoutMillis: 30_000 });
    this.pool.on("error", (error) => log.warn("database: idle client error", { error: error.message }));
  }

  /** Creates or updates the tables. Idempotent; concurrent callers are serialised. */
  async migrate() {
    const schema = await readFile(SCHEMA, "utf8");
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(hashtext('claude-relay:schema'))");
      await client.query(schema);
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  /** Every conversation with its runs, oldest run first. */
  async loadConversations(): Promise<Conversation[]> {
    const conversations = await this.pool.query<{
      id: string;
      title: string;
      session_id: string;
      session_started: boolean;
      repository: string | null;
      open_pr: boolean;
      branch: string | null;
      base_commit: string | null;
      pushed: boolean;
      pr_url: string | null;
    }>(
      `SELECT id, title, session_id, session_started, repository, open_pr, branch, base_commit,
         pushed, pr_url
       FROM conversations ORDER BY created_at, id`,
    );
    const runs = await this.pool.query<{
      id: string;
      conversation_id: string;
      status: RunStatus;
      prompt: string;
      image_count: number | null;
      error: string | null;
      stderr: string | null;
      result_text: string | null;
      is_error: boolean | null;
      started_at: Date;
      finished_at: Date | null;
    }>(
      `SELECT id, conversation_id, status, prompt, image_count, error, stderr, result_text, is_error,
         started_at, finished_at
       FROM runs ORDER BY conversation_id, seq`,
    );
    const messages = await this.pool.query<{
      id: string;
      run_id: string;
      prompt: string;
      image_count: number | null;
      created_at: Date;
    }>("SELECT id, run_id, prompt, image_count, created_at FROM run_messages ORDER BY run_id, seq");
    const messagesByRun = new Map<string, RunMessage[]>();
    for (const row of messages.rows) {
      const list = messagesByRun.get(row.run_id) ?? [];
      list.push({
        id: row.id,
        prompt: row.prompt,
        ...(row.image_count ? { imageCount: row.image_count } : {}),
        sentAt: row.created_at.toISOString(),
      });
      messagesByRun.set(row.run_id, list);
    }
    const byId = new Map<string, Conversation>();
    for (const row of conversations.rows) {
      byId.set(row.id, {
        id: row.id,
        title: row.title,
        sessionId: row.session_id,
        sessionStarted: row.session_started,
        ...(row.repository ? { repository: row.repository } : {}),
        openPr: row.open_pr,
        ...(row.branch ? { branch: row.branch } : {}),
        ...(row.base_commit ? { baseCommit: row.base_commit } : {}),
        pushed: row.pushed,
        ...(row.pr_url ? { prUrl: row.pr_url } : {}),
        runs: [],
      });
    }
    for (const row of runs.rows) {
      byId.get(row.conversation_id)?.runs.push({
        id: row.id,
        status: row.status,
        prompt: row.prompt,
        ...(row.image_count ? { imageCount: row.image_count } : {}),
        ...(row.error ? { error: row.error } : {}),
        ...(row.stderr ? { stderr: row.stderr } : {}),
        ...(row.result_text && row.is_error !== true ? { summary: row.result_text } : {}),
        startedAt: row.started_at.toISOString(),
        ...(row.finished_at ? { finishedAt: row.finished_at.toISOString() } : {}),
        ...(messagesByRun.has(row.id) ? { messages: messagesByRun.get(row.id)! } : {}),
      });
    }
    return [...byId.values()];
  }

  /** Inserts the conversation or updates what can change on it. Rejects if the write failed. */
  saveConversation(conversation: Conversation): Promise<void> {
    const values = [
      conversation.id,
      text(conversation.title),
      conversation.sessionId,
      conversation.sessionStarted,
      conversation.repository ?? null,
      conversation.openPr,
      conversation.branch ?? null,
      conversation.baseCommit ?? null,
      conversation.pushed,
      conversation.prUrl ?? null,
    ];
    return this.enqueue(conversation.id, async () => {
      await this.pool.query(
        `INSERT INTO conversations (id, title, session_id, session_started, repository, open_pr,
           branch, base_commit, pushed, pr_url)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
         ON CONFLICT (id) DO UPDATE SET
           session_started = EXCLUDED.session_started, base_commit = EXCLUDED.base_commit,
           pushed = EXCLUDED.pushed, pr_url = EXCLUDED.pr_url, updated_at = now()`,
        values,
      );
    });
  }

  /**
   * Inserts the run or updates its outcome. `images` are the request's images, stored with
   * the first write. Rejects if the write failed.
   */
  saveRun(conversationId: string, seq: number, run: Run, images?: unknown[]): Promise<void> {
    const values = [
      run.id,
      conversationId,
      seq,
      run.status,
      text(run.prompt),
      images?.length ? json(images) : null,
      run.imageCount ?? null,
      run.error ? text(run.error) : null,
      run.stderr ? text(run.stderr) : null,
      run.startedAt,
      run.finishedAt ?? null,
    ];
    return this.enqueue(conversationId, async () => {
      await this.pool.query(
        `INSERT INTO runs (id, conversation_id, seq, status, prompt, images, image_count, error,
           stderr, started_at, finished_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
         ON CONFLICT (id) DO UPDATE SET
           status = EXCLUDED.status, error = EXCLUDED.error, stderr = EXCLUDED.stderr,
           finished_at = EXCLUDED.finished_at`,
        values,
      );
    });
  }

  /** Stores a message sent to a running run. `seq` counts from 1 within the run. Rejects if the write failed. */
  saveRunMessage(conversationId: string, runId: string, seq: number, message: RunMessage, images?: unknown[]): Promise<void> {
    const values = [
      message.id,
      runId,
      seq,
      text(message.prompt),
      images?.length ? json(images) : null,
      message.imageCount ?? null,
      message.sentAt,
    ];
    return this.enqueue(conversationId, async () => {
      await this.pool.query(
        `INSERT INTO run_messages (id, run_id, seq, prompt, images, image_count, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        values,
      );
    });
  }

  /**
   * Records one stream-json line, and whatever it says about the run and its tool calls.
   * Not awaited by the run; a failed write is logged. `flush` waits for pending writes.
   */
  saveEvent(conversationId: string, runId: string, seq: number, at: Date, event: ClaudeEvent) {
    this.enqueue(conversationId, () => this.writeEvent(runId, seq, at, event)).catch(
      (error: unknown) =>
        log.error("database: event write failed", {
          conversation: conversationId,
          run: runId,
          seq,
          error: error instanceof Error ? error.message : String(error),
        }),
    );
  }

  /** The stored events of the given runs, in order, keyed by run id. */
  async events(runIds: string[]): Promise<Map<string, StoredEvent[]>> {
    const result = new Map<string, StoredEvent[]>(runIds.map((id) => [id, []]));
    if (!runIds.length) return result;
    const rows = await this.pool.query<{ run_id: string; raw: ClaudeEvent; created_at: Date }>(
      "SELECT run_id, raw, created_at FROM events WHERE run_id = ANY($1) ORDER BY run_id, seq",
      [runIds],
    );
    for (const row of rows.rows)
      result.get(row.run_id)?.push({ at: row.created_at.toISOString(), event: row.raw });
    return result;
  }

  /** Resolves once every queued write has been attempted. */
  async flush() {
    while (this.queues.size) await Promise.all(this.queues.values());
  }

  /** Flushes and disconnects. Safe to call more than once. */
  async close() {
    if (this.closed) return;
    this.closed = true;
    await this.flush();
    await this.pool.end();
  }

  /** Runs `write` after every earlier write for the same conversation has settled. */
  private enqueue(conversationId: string, write: () => Promise<void>): Promise<void> {
    const result = (this.queues.get(conversationId) ?? Promise.resolve()).then(write);
    const settled = result.then(
      () => undefined,
      () => undefined,
    );
    this.queues.set(conversationId, settled);
    void settled.then(() => {
      if (this.queues.get(conversationId) === settled) this.queues.delete(conversationId);
    });
    return result;
  }

  private async writeEvent(runId: string, seq: number, at: Date, event: ClaudeEvent) {
    const message = isObject(event.message) ? event.message : undefined;
    const usage = isObject(message?.usage) ? message.usage : undefined;
    const content = Array.isArray(message?.content) ? message.content : undefined;
    const parent = str(event.parent_tool_use_id);
    const inserted = await this.pool.query<{ id: string }>(
      `INSERT INTO events (run_id, seq, type, subtype, uuid, session_id, parent_tool_use_id,
         role, api_message_id, model, stop_reason, content, input_tokens, output_tokens,
         cache_creation_input_tokens, cache_read_input_tokens, raw, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18)
       ON CONFLICT (run_id, seq) DO NOTHING
       RETURNING id`,
      [
        runId,
        seq,
        str(event.type) ?? "unknown",
        str(event.subtype) ?? null,
        uuid(event.uuid),
        uuid(event.session_id),
        parent ?? null,
        str(message?.role) ?? null,
        str(message?.id) ?? null,
        str(message?.model) ?? null,
        str(message?.stop_reason) ?? null,
        content ? json(content) : null,
        int(usage?.input_tokens),
        int(usage?.output_tokens),
        int(usage?.cache_creation_input_tokens),
        int(usage?.cache_read_input_tokens),
        json(event),
        at.toISOString(),
      ],
    );
    const eventId = inserted.rows[0]?.id;
    if (!eventId) return;

    if (event.type === "system" && event.subtype === "init") {
      await this.pool.query("UPDATE runs SET model = $2, claude_code_version = $3 WHERE id = $1", [
        runId,
        str(event.model) ?? null,
        str(event.claude_code_version) ?? null,
      ]);
    }
    for (const block of content ?? []) {
      if (!isObject(block)) continue;
      if (event.type === "assistant" && block.type === "tool_use" && str(block.id)) {
        await this.pool.query(
          `INSERT INTO tool_calls (id, run_id, event_id, parent_tool_use_id, name, input, started_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7) ON CONFLICT (id) DO NOTHING`,
          [
            block.id,
            runId,
            eventId,
            parent ?? null,
            str(block.name) ?? "unknown",
            json(block.input ?? {}),
            timestamp(event, at),
          ],
        );
      }
      if (event.type === "user" && block.type === "tool_result" && str(block.tool_use_id)) {
        await this.pool.query(
          `UPDATE tool_calls SET result_event_id = $2, result = $3, is_error = $4, completed_at = $5
           WHERE id = $1`,
          [
            block.tool_use_id,
            eventId,
            json(block.content ?? null),
            block.is_error === true,
            timestamp(event, at),
          ],
        );
      }
    }
    if (event.type === "result") {
      const total = isObject(event.usage) ? event.usage : {};
      await this.pool.query(
        `UPDATE runs SET result_subtype = $2, result_text = $3, is_error = $4, num_turns = $5,
           duration_ms = $6, duration_api_ms = $7, total_cost_usd = $8, input_tokens = $9,
           output_tokens = $10, cache_creation_input_tokens = $11, cache_read_input_tokens = $12,
           usage = $13
         WHERE id = $1`,
        [
          runId,
          str(event.subtype) ?? null,
          typeof event.result === "string" ? text(event.result) : null,
          typeof event.is_error === "boolean" ? event.is_error : null,
          int(event.num_turns),
          int(event.duration_ms),
          int(event.duration_api_ms),
          typeof event.total_cost_usd === "number" ? event.total_cost_usd : null,
          int(total.input_tokens),
          int(total.output_tokens),
          int(total.cache_creation_input_tokens),
          int(total.cache_read_input_tokens),
          json({ usage: event.usage ?? null, modelUsage: event.modelUsage ?? null }),
        ],
      );
    }
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function str(value: unknown) {
  return typeof value === "string" && value ? text(value) : undefined;
}

function int(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? Math.round(value) : null;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function uuid(value: unknown) {
  return typeof value === "string" && UUID.test(value) ? value : null;
}

function timestamp(event: ClaudeEvent, fallback: Date) {
  const value = typeof event.timestamp === "string" ? Date.parse(event.timestamp) : NaN;
  return Number.isNaN(value) ? fallback.toISOString() : new Date(value).toISOString();
}

/** PostgreSQL text and jsonb cannot hold NUL characters. */
function text(value: string) {
  return value.replaceAll("\0", "�");
}

function json(value: unknown) {
  return JSON.stringify(value, (_key, item: unknown) =>
    typeof item === "string" ? text(item) : item,
  );
}
