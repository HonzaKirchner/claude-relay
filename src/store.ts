import { appendFile, mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";
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
  /** The checkout's origin, as a browser link. */
  repository?: string;
  /**
   * Launched with `NO_REPOSITORY`: it works in the root, in no checkout, so it has no
   * repository and no branch, and nothing of it is committed, pushed or opened as a PR.
   */
  noRepository?: true;
  openPr: boolean;
  /** `agent/<id>`: the conversation's branch in the shared checkout. */
  branch?: string;
  /** What `branch` was started from when the launch named it; else the origin's default branch. */
  baseBranch?: string;
  baseCommit?: string;
  pushed: boolean;
  prUrl?: string;
  /** Oldest first; a run's seq is its position + 1. */
  runs: Run[];
}

/**
 * What the service must remember across a restart, as files in one directory on the workspace's
 * disk: `conversations/<id>.json` (the conversation with its runs) and `events/<runId>.jsonl`
 * (one `{ at, event }` per line, in the order Claude printed them). The record people read is
 * kept elsewhere: whoever manages the workspace fetches the events from here (see
 * `GET /conversations/:id/transcript`) and stores them.
 *
 * Writes for one conversation are applied in order. Conversation and run writes return a
 * promise that rejects if the write failed, so callers can refuse to go on without it. Event
 * writes are fire-and-forget (a run produces many); `flush` waits for them.
 */
export class Store {
  private readonly dir: string;
  /** What the files hold, by conversation id: the store's own copy, never the runner's objects. */
  private readonly known = new Map<string, Conversation>();
  private readonly queues = new Map<string, Promise<unknown>>();

  constructor(dir: string) {
    this.dir = dir;
  }

  /** Creates the directories. Safe to repeat. */
  async prepare() {
    await mkdir(path.join(this.dir, "conversations"), { recursive: true, mode: 0o700 });
    await mkdir(path.join(this.dir, "events"), { recursive: true, mode: 0o700 });
  }

  async loadConversations(): Promise<Conversation[]> {
    const folder = path.join(this.dir, "conversations");
    for (const name of (await readdir(folder)).filter((file) => file.endsWith(".json")).sort()) {
      try {
        const conversation = JSON.parse(await readFile(path.join(folder, name), "utf8")) as Conversation;
        this.known.set(conversation.id, conversation);
      } catch (error) {
        // One unreadable file must not keep the service, and every other conversation, down.
        log.error("store: conversation file unreadable, skipped", {
          file: name,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return [...this.known.values()].map((conversation) => structuredClone(conversation));
  }

  /** The conversation's own fields. Its runs are written by `saveRun`. */
  saveConversation(conversation: Conversation): Promise<void> {
    return this.enqueue(conversation.id, () => {
      const { runs: _runs, ...fields } = conversation;
      const kept = this.known.get(conversation.id);
      return this.write({ ...structuredClone(fields), runs: kept?.runs ?? [] });
    });
  }

  /** The run at `seq` (from 1) of a conversation already saved. */
  saveRun(conversationId: string, seq: number, run: Run): Promise<void> {
    return this.enqueue(conversationId, () => {
      const kept = this.known.get(conversationId);
      if (!kept) throw new Error(`conversation ${conversationId} is not stored`);
      const runs = [...kept.runs];
      runs[seq - 1] = structuredClone(run);
      return this.write({ ...kept, runs });
    });
  }

  /** A message sent to a running run, appended to that run's messages unless it is there already. */
  saveRunMessage(conversationId: string, runId: string, message: RunMessage): Promise<void> {
    return this.enqueue(conversationId, () => {
      const kept = this.known.get(conversationId);
      const index = kept?.runs.findIndex((run) => run.id === runId) ?? -1;
      if (!kept || index < 0) throw new Error(`run ${runId} is not stored`);
      const run = kept.runs[index]!;
      if (run.messages?.some((item) => item.id === message.id)) return Promise.resolve();
      const runs = [...kept.runs];
      runs[index] = { ...run, messages: [...(run.messages ?? []), structuredClone(message)] };
      return this.write({ ...kept, runs });
    });
  }

  saveEvent(conversationId: string, runId: string, at: Date, event: ClaudeEvent) {
    const line = `${JSON.stringify({ at: at.toISOString(), event })}\n`;
    this.enqueue(conversationId, () => appendFile(this.eventsFile(runId), line, { mode: 0o600 })).catch(
      (error: unknown) =>
        log.error("store: event write failed", {
          conversation: conversationId,
          run: runId,
          error: error instanceof Error ? error.message : String(error),
        }),
    );
  }

  /** The stored events of the given runs, in order, keyed by run id. */
  async events(runIds: string[]): Promise<Map<string, StoredEvent[]>> {
    const result = new Map<string, StoredEvent[]>();
    for (const id of runIds) {
      const text = await readFile(this.eventsFile(id), "utf8").catch(() => "");
      const events: StoredEvent[] = [];
      for (const line of text.split("\n")) {
        if (!line) continue;
        try {
          events.push(JSON.parse(line) as StoredEvent);
        } catch {
          // A line cut off by a crash mid-write: what came before it stands.
          break;
        }
      }
      result.set(id, events);
    }
    return result;
  }

  /** Resolves once every queued write has been attempted. */
  async flush() {
    while (this.queues.size) await Promise.all(this.queues.values());
  }

  private eventsFile(runId: string) {
    return path.join(this.dir, "events", `${runId}.jsonl`);
  }

  /** Whole, or not at all: written beside the file, then moved over it. */
  private async write(conversation: Conversation) {
    const file = path.join(this.dir, "conversations", `${conversation.id}.json`);
    await writeFile(`${file}.tmp`, JSON.stringify(conversation), { mode: 0o600 });
    await rename(`${file}.tmp`, file);
    this.known.set(conversation.id, conversation);
  }

  private enqueue<T>(key: string, work: () => Promise<T>): Promise<T> {
    const next = (this.queues.get(key) ?? Promise.resolve()).then(work, work);
    const settled = next.catch(() => undefined);
    this.queues.set(key, settled);
    void settled.then(() => {
      if (this.queues.get(key) === settled) this.queues.delete(key);
    });
    return next;
  }
}
