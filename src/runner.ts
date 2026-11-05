import type { ChildProcess } from "node:child_process";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, rename, rm, stat } from "node:fs/promises";
import path from "node:path";
import type { ClaudeEvent, Conversation, Run, RunStatus, Store, StoredEvent } from "./db.ts";
import { log, since } from "./log.ts";

export type { RunStatus } from "./db.ts";

export type Image = { data: string; mimeType: string } | { url: string };

export interface PromptRequest {
  prompt: string;
  images?: Image[];
}

export interface LaunchRequest extends PromptRequest {
  repository?: string;
  openPr?: boolean;
}

/**
 * What the HTTP API returns for one run of a conversation. Rakazo calls a conversation an
 * "agent"; the API serves it under both `/conversations/:id` and `/agents/:id`.
 */
export interface ConversationView {
  id: string;
  title: string;
  status: RunStatus;
  runId: string;
  branch?: string;
  prUrl?: string;
  error?: string;
  /** Where a person can follow the run in a browser. Only when the public URL is known. */
  url?: string;
}

/** Everything the transcript page shows about a conversation. */
export interface Transcript {
  id: string;
  title: string;
  repository?: string;
  branch?: string;
  pushed: boolean;
  prUrl?: string;
  runs: Array<Run & { seq: number; events: StoredEvent[] }>;
}

/** One line of the conversation list on the transcript page. */
export interface ConversationSummary {
  id: string;
  title: string;
  /** The latest run's status. */
  status: Run["status"];
  runCount: number;
  repository?: string;
  /** When the latest run started or finished, whichever is later. */
  updatedAt: string;
}

export interface RunnerOptions {
  /** Where conversations, runs and events are stored. The only persistent state. */
  store: Store;
  /** Holds the git checkouts Claude works in (`work/<id>`); no conversation data. */
  dataDir: string;
  claudeCommand: string;
  ghCommand: string;
  env?: NodeJS.ProcessEnv;
  /** The service's base URL as seen from a browser (through Coder's app proxy). */
  publicUrl?: string;
}

export class ConversationBusy extends Error {}

const KILL_GRACE_MS = 10_000;
/** How much of a failed git/gh command's stderr goes into the log. */
const STDERR_TAIL = 1_000;
/** How much of Claude Code's stderr is stored with a run. */
const CLAUDE_STDERR_KEPT = 64_000;
/** Longest Claude Code failure text copied into a run's `error`. */
const MAX_ERROR = 500;

/**
 * Runs one headless Claude Code session per conversation, each in its own checkout, and
 * publishes the result as a branch (and optionally a pull request).
 *
 * Every conversation and run lives in the database. The in-memory map is a cache filled
 * from it at start; a change counts only once the database has it.
 */
export class ConversationRunner {
  private readonly options: RunnerOptions;
  private readonly store: Store;
  private readonly conversations = new Map<string, Conversation>();
  /** The child process a conversation is waiting on right now (git, claude or gh). */
  private readonly children = new Map<string, ChildProcess>();
  private readonly active = new Map<string, Promise<void>>();
  private readonly cancelled = new Set<string>();

  constructor(options: RunnerOptions) {
    this.options = options;
    this.store = options.store;
  }

  /** Loads every conversation from the database. A run that was going when the runner stopped can never finish. */
  async load() {
    for (const conversation of await this.store.loadConversations()) {
      this.conversations.set(conversation.id, conversation);
      const run = conversation.runs.at(-1);
      if (run?.status === "running") {
        run.status = "failed";
        run.error = "The runner restarted during this run.";
        run.finishedAt = new Date().toISOString();
        await this.store.saveRun(conversation.id, conversation.runs.length, run);
        log.warn("run interrupted by restart, marked failed", {
          conversation: conversation.id,
          run: run.id,
        });
      }
      await this.repairSession(conversation);
    }
    log.info("loaded conversations", { count: this.conversations.size });
  }

  /** Repeating a launch with the same id returns the existing conversation. */
  async launch(id: string, request: LaunchRequest): Promise<ConversationView> {
    const existing = this.conversations.get(id);
    if (existing) {
      log.info("launch repeated, returning existing conversation", { conversation: id });
      return this.view(existing, existing.runs.at(-1)!);
    }
    const conversation: Conversation = {
      id,
      title: titleOf(request.prompt),
      sessionId: randomUUID(),
      sessionStarted: false,
      ...(request.repository
        ? { repository: request.repository, branch: `agent/${id.slice(0, 12)}` }
        : {}),
      openPr: request.openPr ?? false,
      pushed: false,
      runs: [],
    };
    this.conversations.set(id, conversation);
    return this.start(conversation, request);
  }

  get(id: string, runId?: string): ConversationView | undefined {
    const conversation = this.conversations.get(id);
    const run = runId ? conversation?.runs.find((item) => item.id === runId) : conversation?.runs.at(-1);
    return conversation && run ? this.view(conversation, run) : undefined;
  }

  /** Every conversation, most recently active first. */
  list(): ConversationSummary[] {
    return [...this.conversations.values()]
      .filter((conversation) => conversation.runs.length)
      .map((conversation) => {
        const run = conversation.runs.at(-1)!;
        return {
          id: conversation.id,
          title: conversation.title,
          status: run.status,
          runCount: conversation.runs.length,
          ...(conversation.repository ? { repository: conversation.repository } : {}),
          updatedAt: run.finishedAt ?? run.startedAt,
        };
      })
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  /** The conversation's runs with their Claude Code events. */
  async transcript(id: string): Promise<Transcript | undefined> {
    const conversation = this.conversations.get(id);
    if (!conversation) return undefined;
    const runs = [...conversation.runs];
    const events = await this.store.events(runs.map((run) => run.id));
    return {
      id: conversation.id,
      title: conversation.title,
      ...(conversation.repository ? { repository: conversation.repository } : {}),
      ...(conversation.branch ? { branch: conversation.branch } : {}),
      pushed: conversation.pushed,
      ...(conversation.prUrl ? { prUrl: conversation.prUrl } : {}),
      runs: runs.map((run, index) => ({ ...run, seq: index + 1, events: events.get(run.id) ?? [] })),
    };
  }

  async reply(id: string, request: PromptRequest): Promise<ConversationView | undefined> {
    const conversation = this.conversations.get(id);
    if (!conversation) return undefined;
    if (conversation.runs.at(-1)?.status === "running") {
      log.info("follow-up refused, a run is going", { conversation: id });
      throw new ConversationBusy();
    }
    return this.start(conversation, request);
  }

  /** Resolves once the run has stopped, so the result is never a premature "cancelled". */
  async cancel(id: string, runId: string): Promise<ConversationView | undefined> {
    const conversation = this.conversations.get(id);
    const run = conversation?.runs.find((item) => item.id === runId);
    if (!conversation || !run) return undefined;
    if (run.status === "running") {
      log.info("cancelling run", { conversation: id, run: runId });
      this.cancelled.add(run.id);
      const child = this.children.get(conversation.id);
      if (child) stop(child);
      await this.active.get(conversation.id);
    }
    return this.view(conversation, run);
  }

  /** Waits for every running conversation and pending database write; tests use it to observe finished runs. */
  async idle() {
    await Promise.all(this.active.values());
    await this.store.flush();
  }

  /**
   * Stores the new run (and, for a launch, the conversation) before anything runs. If the
   * database refuses, nothing is started and the conversation is left as it was.
   */
  private async start(conversation: Conversation, request: PromptRequest): Promise<ConversationView> {
    const run: Run = {
      id: randomUUID(),
      status: "running",
      prompt: request.prompt,
      ...(request.images?.length ? { imageCount: request.images.length } : {}),
      startedAt: new Date().toISOString(),
    };
    conversation.runs.push(run);
    const seq = conversation.runs.length;
    try {
      if (seq === 1) await this.store.saveConversation(conversation);
      await this.store.saveRun(conversation.id, seq, run, request.images);
    } catch (error) {
      conversation.runs.pop();
      if (seq === 1) this.conversations.delete(conversation.id);
      log.error("could not store the new run, nothing started", {
        conversation: conversation.id,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
    log.info(seq === 1 ? "conversation launched" : "follow-up started", {
      conversation: conversation.id,
      run: run.id,
      seq,
      title: seq === 1 ? conversation.title : undefined,
      repository: seq === 1 ? conversation.repository : undefined,
      openPr: seq === 1 && conversation.repository ? conversation.openPr : undefined,
      images: request.images?.length,
    });
    const work = this.execute(conversation, run, request).finally(() => {
      this.active.delete(conversation.id);
      this.cancelled.delete(run.id);
    });
    this.active.set(conversation.id, work);
    return this.view(conversation, run);
  }

  private view(conversation: Conversation, run: Run): ConversationView {
    const base = this.options.publicUrl?.replace(/\/+$/, "");
    return {
      ...view(conversation, run),
      ...(base ? { url: `${base}/ui/conversations/${conversation.id}` } : {}),
    };
  }

  /**
   * Records written before the session flag was set on Claude's `system/init` event (or
   * imported from them) may claim a session Claude never created, so every follow-up would
   * fail to `--resume` it. A conversation with no finished run has its flag recomputed from
   * its stored events.
   */
  private async repairSession(conversation: Conversation) {
    if (!conversation.runs.length || conversation.runs.some((run) => run.status === "finished")) return;
    const events = await this.store.events(conversation.runs.map((run) => run.id));
    const started = [...events.values()].some((list) => list.some(({ event }) => isInit(event)));
    if (started === conversation.sessionStarted) return;
    conversation.sessionStarted = started;
    await this.store.saveConversation(conversation);
    log.info("session flag repaired from stored events", {
      conversation: conversation.id,
      sessionStarted: started,
    });
  }

  private async execute(conversation: Conversation, run: Run, request: PromptRequest) {
    const workdir = path.join(this.options.dataDir, "work", conversation.id);
    const started = performance.now();
    try {
      await this.prepare(conversation, workdir);
      const outcome = await this.claude(conversation, run, request, workdir);
      if (this.cancelled.has(run.id)) run.status = "cancelled";
      else if (!outcome.ok) {
        run.status = "failed";
        run.error = outcome.error;
      } else {
        if (conversation.repository) await this.publish(conversation, workdir);
        run.status = "finished";
      }
    } catch (error) {
      run.status = this.cancelled.has(run.id) ? "cancelled" : "failed";
      if (run.status === "failed")
        run.error = error instanceof Error ? error.message : "The run failed.";
    }
    run.finishedAt = new Date().toISOString();
    try {
      await this.store.saveConversation(conversation);
      await this.store.saveRun(conversation.id, conversation.runs.indexOf(run) + 1, run);
    } catch (error) {
      // Served from memory until the next restart, which will report the run as failed.
      log.error("could not store the run's outcome", {
        conversation: conversation.id,
        run: run.id,
        status: run.status,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    const fields = {
      conversation: conversation.id,
      run: run.id,
      status: run.status,
      ms: since(started),
      error: run.error,
      branch: conversation.pushed ? conversation.branch : undefined,
      pr: conversation.prUrl,
    };
    if (run.status === "failed") log.warn("run ended", fields);
    else log.info("run ended", fields);
  }

  private async prepare(conversation: Conversation, workdir: string) {
    if (await exists(workdir)) return;
    const partial = `${workdir}.partial`;
    await rm(partial, { recursive: true, force: true });
    await mkdir(path.dirname(workdir), { recursive: true });
    if (conversation.repository) {
      log.info("cloning repository", { conversation: conversation.id, repository: conversation.repository });
      await this.exec(conversation, "git", ["clone", "--", conversation.repository, partial], undefined, {
        error: "Could not clone the repository.",
      });
      await this.exec(conversation, "git", ["checkout", "-b", conversation.branch!], partial, {
        error: "Could not create the conversation's branch.",
      });
      conversation.baseCommit = (
        await this.exec(conversation, "git", ["rev-parse", "HEAD"], partial, {
          error: "Could not read the repository.",
        })
      ).trim();
      // Publishing needs it on every later run, so the run cannot go on without it stored.
      await this.store.saveConversation(conversation);
    } else {
      await mkdir(partial);
    }
    await rename(partial, workdir);
  }

  private async claude(
    conversation: Conversation,
    run: Run,
    request: PromptRequest,
    workdir: string,
  ): Promise<{ ok: true } | { ok: false; error: string }> {
    const note = conversation.branch
      ? `You are working on the git branch ${conversation.branch}; stay on it. When you finish, any uncommitted changes are committed and the branch is pushed${conversation.openPr ? " with a pull request" : ""}, so do not push or open a pull request yourself.`
      : "";
    const args = [
      "--print",
      "--input-format",
      "stream-json",
      "--output-format",
      "stream-json",
      "--verbose",
      "--dangerously-skip-permissions",
      ...(note ? ["--append-system-prompt", note] : []),
      ...(conversation.sessionStarted ? ["--resume", conversation.sessionId] : ["--session-id", conversation.sessionId]),
    ];
    this.throwIfCancelled(conversation);
    const child = spawn(this.options.claudeCommand, args, {
      cwd: workdir,
      env: this.options.env ?? process.env,
      stdio: ["pipe", "pipe", "pipe"],
      detached: true,
    });
    this.children.set(conversation.id, child);
    log.info("claude started", {
      conversation: conversation.id,
      run: run.id,
      pid: child.pid,
      session: conversation.sessionStarted ? "resume" : "new",
    });
    let buffered = "";
    let stderr = "";
    let succeeded = false;
    let result: ClaudeEvent | undefined;
    let sessionSaved: Promise<void> | undefined;
    let seq = 0;
    const onLine = (line: string) => {
      const event = parseLine(line);
      if (!event) return;
      if (event.type === "result") {
        succeeded = event.is_error !== true;
        result = event;
      }
      // Only now does the session exist; until then a follow-up must not `--resume` it.
      // Stored right away so a crash later in the run cannot lose it.
      if (!conversation.sessionStarted && isInit(event)) {
        conversation.sessionStarted = true;
        sessionSaved = this.store.saveConversation(conversation);
        sessionSaved.catch(() => undefined); // Awaited (and reported) once Claude exits.
      }
      seq += 1;
      this.store.saveEvent(conversation.id, run.id, seq, new Date(), event);
    };
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      buffered += chunk;
      const lines = buffered.split("\n");
      buffered = lines.pop() ?? "";
      lines.forEach(onLine);
    });
    child.stdout.on("end", () => onLine(buffered));
    child.stderr.on("data", (chunk: Buffer) => {
      stderr = (stderr + chunk.toString("utf8")).slice(-CLAUDE_STDERR_KEPT);
    });
    child.stdin.on("error", () => undefined);
    child.stdin.end(`${JSON.stringify(userMessage(request))}\n`);
    const code = await exitCode(child);
    this.children.delete(conversation.id);
    if (stderr.trim()) run.stderr = stderr;
    const fields = {
      conversation: conversation.id,
      run: run.id,
      exit: code ?? "signal",
      result: typeof result?.subtype === "string" ? result.subtype : "none",
      turns: typeof result?.num_turns === "number" ? result.num_turns : undefined,
      costUsd: typeof result?.total_cost_usd === "number" ? result.total_cost_usd.toFixed(4) : undefined,
      events: seq,
    };
    if ((code === 0 && succeeded) || this.cancelled.has(run.id)) log.info("claude exited", fields);
    else log.warn("claude exited", { ...fields, stderr: lastLine(stderr) });
    // Without the stored flag a later run would try to create the session again.
    await sessionSaved;
    return code === 0 && succeeded ? { ok: true } : { ok: false, error: failureReason(result, stderr, code) };
  }

  private async publish(conversation: Conversation, workdir: string) {
    await this.exec(conversation, "git", ["add", "--all"], workdir);
    if ((await this.exec(conversation, "git", ["status", "--porcelain"], workdir)).trim()) {
      await this.exec(conversation, "git", ["commit", "--message", conversation.title], workdir, {
        error: "Could not commit the changes.",
      });
    }
    const ahead = Number(
      await this.exec(conversation, "git", ["rev-list", "--count", `${conversation.baseCommit}..HEAD`], workdir),
    );
    if (!ahead) {
      log.info("nothing to publish, no new commits", { conversation: conversation.id });
      return;
    }
    await this.exec(
      conversation,
      "git",
      ["push", "--set-upstream", "origin", `HEAD:refs/heads/${conversation.branch}`],
      workdir,
      { error: "Could not push the branch." },
    );
    conversation.pushed = true;
    log.info("branch pushed", { conversation: conversation.id, branch: conversation.branch, commits: ahead });
    if (conversation.openPr && !conversation.prUrl) {
      // Fails when the branch has no PR yet, which is the usual case.
      const existing = lastLine(
        await this.exec(
          conversation,
          this.options.ghCommand,
          ["pr", "view", conversation.branch!, "--json", "url", "--jq", ".url"],
          workdir,
          { quiet: true },
        ).catch(() => ""),
      );
      conversation.prUrl =
        existing ||
        lastLine(
          await this.exec(
            conversation,
            this.options.ghCommand,
            ["pr", "create", "--head", conversation.branch!, "--fill"],
            workdir,
            { error: "Could not open the pull request." },
          ),
        );
      log.info(existing ? "pull request reused" : "pull request opened", {
        conversation: conversation.id,
        pr: conversation.prUrl,
      });
    }
  }

  /** Runs a command as the conversation's current child, so cancel can stop it. */
  private async exec(
    conversation: Conversation,
    command: string,
    args: string[],
    cwd?: string,
    /** `quiet` skips the failure log for commands that are expected to fail. */
    options: { error?: string; quiet?: boolean } = {},
  ): Promise<string> {
    this.throwIfCancelled(conversation);
    const started = performance.now();
    const child = spawn(command, args, {
      cwd,
      env: { ...(this.options.env ?? process.env), GIT_TERMINAL_PROMPT: "0" },
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
    });
    this.children.set(conversation.id, child);
    let output = "";
    let errors = "";
    child.stdout.on("data", (chunk: Buffer) => {
      output += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      errors = (errors + chunk.toString("utf8")).slice(-STDERR_TAIL);
    });
    const code = await exitCode(child);
    this.children.delete(conversation.id);
    const name = `${path.basename(command)} ${args[0] ?? ""}`.trim();
    log.debug("command ran", { conversation: conversation.id, command: name, exit: code, ms: since(started) });
    if (code !== 0) {
      if (!options.quiet && !this.cancelled.has(conversation.runs.at(-1)?.id ?? ""))
        log.warn("command failed", {
          conversation: conversation.id,
          command: name,
          exit: code ?? "signal",
          stderr: errors.trim(),
        });
      throw new Error(options.error ?? `${path.basename(command)} failed.`);
    }
    return output;
  }

  /** Cancel may land between two commands, when there is no child to stop. */
  private throwIfCancelled(conversation: Conversation) {
    const run = conversation.runs.at(-1);
    if (run && this.cancelled.has(run.id)) throw new Error("Cancelled.");
  }
}

function view(conversation: Conversation, run: Run): ConversationView {
  return {
    id: conversation.id,
    title: conversation.title,
    status: run.status,
    runId: run.id,
    ...(conversation.pushed && conversation.branch ? { branch: conversation.branch } : {}),
    ...(conversation.prUrl ? { prUrl: conversation.prUrl } : {}),
    ...(run.error ? { error: run.error } : {}),
  };
}

function titleOf(prompt: string) {
  const line = prompt.trim().split("\n")[0]!.trim();
  return line.length > 80 ? `${line.slice(0, 79)}…` : line;
}

function userMessage(request: PromptRequest) {
  const images = (request.images ?? []).map((image) =>
    "url" in image
      ? { type: "image", source: { type: "url", url: image.url } }
      : { type: "image", source: { type: "base64", media_type: image.mimeType, data: image.data } },
  );
  return {
    type: "user",
    message: { role: "user", content: [{ type: "text", text: request.prompt }, ...images] },
  };
}

function parseLine(line: string): ClaudeEvent | undefined {
  if (!line.trim()) return undefined;
  try {
    const value: unknown = JSON.parse(line);
    return value && typeof value === "object" && !Array.isArray(value)
      ? (value as ClaudeEvent)
      : undefined;
  } catch {
    return undefined;
  }
}

function isInit(event: ClaudeEvent) {
  return event.type === "system" && event.subtype === "init";
}

/**
 * Why Claude Code failed, in its own words where it gave any: the failed result's text,
 * else the last line it wrote to stderr (e.g. a refusal to start), else its result subtype.
 */
function failureReason(result: ClaudeEvent | undefined, stderr: string, code: number | null) {
  const text =
    (result?.is_error === true && typeof result.result === "string" && result.result.trim()) ||
    lastLine(stderr) ||
    (typeof result?.subtype === "string" && result.subtype !== "success" ? result.subtype : "") ||
    (code === null ? "it was stopped by a signal" : `it exited with code ${code} without a result`);
  const reason = text.length > MAX_ERROR ? `${text.slice(0, MAX_ERROR - 1)}…` : text;
  return `Claude Code failed: ${reason}`;
}

function lastLine(output: string) {
  return output.trim().split("\n").at(-1)?.trim() ?? "";
}

/** Stops the whole process group: the conversation's own commands and servers go with it. */
function stop(child: ChildProcess) {
  const signal = (name: NodeJS.Signals) => {
    try {
      if (child.pid) process.kill(-child.pid, name);
    } catch {
      // Already gone.
    }
  };
  signal("SIGTERM");
  setTimeout(() => signal("SIGKILL"), KILL_GRACE_MS).unref();
}

function exitCode(child: ChildProcess) {
  return new Promise<number | null>((resolve) => {
    child.once("error", () => resolve(null));
    child.once("close", (code) => resolve(code));
  });
}

async function exists(file: string) {
  return stat(file).then(
    () => true,
    () => false,
  );
}
