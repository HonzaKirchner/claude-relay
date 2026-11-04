import type { ChildProcess } from "node:child_process";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";

export type RunStatus = "running" | "finished" | "failed" | "cancelled";

export type Image = { data: string; mimeType: string } | { url: string };

export interface PromptRequest {
  prompt: string;
  images?: Image[];
}

export interface LaunchRequest extends PromptRequest {
  repository?: string;
  openPr?: boolean;
}

interface Run {
  id: string;
  status: RunStatus;
  error?: string;
}

interface AgentRecord {
  id: string;
  title: string;
  sessionId: string;
  sessionStarted: boolean;
  repository?: string;
  openPr: boolean;
  branch?: string;
  baseCommit?: string;
  pushed: boolean;
  prUrl?: string;
  runs: Run[];
}

/** What the HTTP API returns for one run of an agent. */
export interface AgentView {
  id: string;
  title: string;
  status: RunStatus;
  runId: string;
  branch?: string;
  prUrl?: string;
  error?: string;
}

export interface RunnerOptions {
  /** Holds agent records, checkouts and run logs. Survives workspace restarts. */
  dataDir: string;
  claudeCommand: string;
  ghCommand: string;
  env?: NodeJS.ProcessEnv;
}

export class AgentBusy extends Error {}

const KILL_GRACE_MS = 10_000;

/**
 * Runs one headless Claude Code session per agent, each in its own checkout, and
 * publishes the result as a branch (and optionally a pull request).
 */
export class AgentRunner {
  private readonly options: RunnerOptions;
  private readonly agents = new Map<string, AgentRecord>();
  /** The child process an agent is waiting on right now (git, claude or gh). */
  private readonly children = new Map<string, ChildProcess>();
  private readonly active = new Map<string, Promise<void>>();
  private readonly cancelled = new Set<string>();

  constructor(options: RunnerOptions) {
    this.options = options;
  }

  /** Load saved agents. A run that was going when the runner stopped can never finish. */
  async load() {
    const dir = path.join(this.options.dataDir, "agents");
    await mkdir(dir, { recursive: true });
    for (const name of await readdir(dir)) {
      if (!name.endsWith(".json")) continue;
      const agent = JSON.parse(await readFile(path.join(dir, name), "utf8")) as AgentRecord;
      this.agents.set(agent.id, agent);
      const run = agent.runs.at(-1);
      if (run?.status === "running") {
        run.status = "failed";
        run.error = "The runner restarted during this run.";
        await this.save(agent);
      }
    }
  }

  /** Repeating a launch with the same id returns the existing agent. */
  async launch(id: string, request: LaunchRequest): Promise<AgentView> {
    const existing = this.agents.get(id);
    if (existing) return view(existing, existing.runs.at(-1)!);
    const agent: AgentRecord = {
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
    this.agents.set(id, agent);
    return this.start(agent, request);
  }

  get(id: string, runId?: string): AgentView | undefined {
    const agent = this.agents.get(id);
    const run = runId ? agent?.runs.find((item) => item.id === runId) : agent?.runs.at(-1);
    return agent && run ? view(agent, run) : undefined;
  }

  async reply(id: string, request: PromptRequest): Promise<AgentView | undefined> {
    const agent = this.agents.get(id);
    if (!agent) return undefined;
    if (agent.runs.at(-1)?.status === "running") throw new AgentBusy();
    return this.start(agent, request);
  }

  /** Resolves once the run has stopped, so the result is never a premature "cancelled". */
  async cancel(id: string, runId: string): Promise<AgentView | undefined> {
    const agent = this.agents.get(id);
    const run = agent?.runs.find((item) => item.id === runId);
    if (!agent || !run) return undefined;
    if (run.status === "running") {
      this.cancelled.add(run.id);
      const child = this.children.get(agent.id);
      if (child) stop(child);
      await this.active.get(agent.id);
    }
    return view(agent, run);
  }

  /** Waits for every running agent; tests use it to observe finished runs. */
  async idle() {
    await Promise.all(this.active.values());
  }

  private async start(agent: AgentRecord, request: PromptRequest): Promise<AgentView> {
    const run: Run = { id: randomUUID(), status: "running" };
    agent.runs.push(run);
    await this.save(agent);
    const work = this.execute(agent, run, request).finally(() => {
      this.active.delete(agent.id);
      this.cancelled.delete(run.id);
    });
    this.active.set(agent.id, work);
    return view(agent, run);
  }

  private async execute(agent: AgentRecord, run: Run, request: PromptRequest) {
    const workdir = path.join(this.options.dataDir, "work", agent.id);
    try {
      await this.prepare(agent, workdir);
      const ok = await this.claude(agent, run, request, workdir);
      if (this.cancelled.has(run.id)) run.status = "cancelled";
      else if (!ok) {
        run.status = "failed";
        run.error = "Claude Code did not finish the task.";
      } else {
        if (agent.repository) await this.publish(agent, workdir);
        run.status = "finished";
      }
    } catch (error) {
      run.status = this.cancelled.has(run.id) ? "cancelled" : "failed";
      if (run.status === "failed")
        run.error = error instanceof Error ? error.message : "The run failed.";
    }
    await this.save(agent);
  }

  private async prepare(agent: AgentRecord, workdir: string) {
    if (await exists(workdir)) return;
    const partial = `${workdir}.partial`;
    await rm(partial, { recursive: true, force: true });
    await mkdir(path.dirname(workdir), { recursive: true });
    if (agent.repository) {
      await this.exec(agent, "git", ["clone", "--", agent.repository, partial], undefined, {
        error: "Could not clone the repository.",
      });
      await this.exec(agent, "git", ["checkout", "-b", agent.branch!], partial, {
        error: "Could not create the agent's branch.",
      });
      agent.baseCommit = (
        await this.exec(agent, "git", ["rev-parse", "HEAD"], partial, {
          error: "Could not read the repository.",
        })
      ).trim();
    } else {
      await mkdir(partial);
    }
    await rename(partial, workdir);
    await this.save(agent);
  }

  private async claude(agent: AgentRecord, run: Run, request: PromptRequest, workdir: string) {
    const note = agent.branch
      ? `You are working on the git branch ${agent.branch}; stay on it. When you finish, any uncommitted changes are committed and the branch is pushed${agent.openPr ? " with a pull request" : ""}, so do not push or open a pull request yourself.`
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
      ...(agent.sessionStarted ? ["--resume", agent.sessionId] : ["--session-id", agent.sessionId]),
    ];
    const logDir = path.join(this.options.dataDir, "logs", agent.id);
    await mkdir(logDir, { recursive: true });
    this.throwIfCancelled(agent);
    const log = createWriteStream(path.join(logDir, `${run.id}.jsonl`));
    const child = spawn(this.options.claudeCommand, args, {
      cwd: workdir,
      env: this.options.env ?? process.env,
      stdio: ["pipe", "pipe", "pipe"],
      detached: true,
    });
    this.children.set(agent.id, child);
    let buffered = "";
    let succeeded = false;
    child.stdout.on("data", (chunk: Buffer) => {
      log.write(chunk);
      buffered += chunk.toString("utf8");
      const lines = buffered.split("\n");
      buffered = lines.pop() ?? "";
      for (const line of lines) {
        const message = parseLine(line);
        if (message?.type === "result") succeeded = message.is_error !== true;
      }
    });
    child.stderr.on("data", (chunk: Buffer) => log.write(chunk));
    child.stdin.on("error", () => undefined);
    child.stdin.end(`${JSON.stringify(userMessage(request))}\n`);
    const exited = exitCode(child);
    agent.sessionStarted = true;
    await this.save(agent);
    const code = await exited;
    this.children.delete(agent.id);
    await new Promise((resolve) => log.end(resolve));
    return code === 0 && succeeded;
  }

  private async publish(agent: AgentRecord, workdir: string) {
    await this.exec(agent, "git", ["add", "--all"], workdir);
    if ((await this.exec(agent, "git", ["status", "--porcelain"], workdir)).trim()) {
      await this.exec(agent, "git", ["commit", "--message", agent.title], workdir, {
        error: "Could not commit the changes.",
      });
    }
    const ahead = Number(
      await this.exec(agent, "git", ["rev-list", "--count", `${agent.baseCommit}..HEAD`], workdir),
    );
    if (!ahead) return;
    await this.exec(
      agent,
      "git",
      ["push", "--set-upstream", "origin", `HEAD:refs/heads/${agent.branch}`],
      workdir,
      { error: "Could not push the branch." },
    );
    agent.pushed = true;
    if (agent.openPr && !agent.prUrl) {
      const existing = await this.exec(
        agent,
        this.options.ghCommand,
        ["pr", "view", agent.branch!, "--json", "url", "--jq", ".url"],
        workdir,
      ).catch(() => "");
      agent.prUrl =
        lastLine(existing) ||
        lastLine(
          await this.exec(
            agent,
            this.options.ghCommand,
            ["pr", "create", "--head", agent.branch!, "--fill"],
            workdir,
            { error: "Could not open the pull request." },
          ),
        );
    }
    await this.save(agent);
  }

  /** Runs a command as the agent's current child, so cancel can stop it. */
  private async exec(
    agent: AgentRecord,
    command: string,
    args: string[],
    cwd?: string,
    options: { error?: string } = {},
  ): Promise<string> {
    this.throwIfCancelled(agent);
    const child = spawn(command, args, {
      cwd,
      env: { ...(this.options.env ?? process.env), GIT_TERMINAL_PROMPT: "0" },
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
    });
    this.children.set(agent.id, child);
    let output = "";
    child.stdout.on("data", (chunk: Buffer) => {
      output += chunk.toString("utf8");
    });
    child.stderr.resume();
    const code = await exitCode(child);
    this.children.delete(agent.id);
    if (code !== 0) throw new Error(options.error ?? `${path.basename(command)} failed.`);
    return output;
  }

  /** Cancel may land between two commands, when there is no child to stop. */
  private throwIfCancelled(agent: AgentRecord) {
    const run = agent.runs.at(-1);
    if (run && this.cancelled.has(run.id)) throw new Error("Cancelled.");
  }

  private async save(agent: AgentRecord) {
    const file = path.join(this.options.dataDir, "agents", `${agent.id}.json`);
    const temporary = `${file}.${randomUUID()}.tmp`;
    await writeFile(temporary, JSON.stringify(agent));
    await rename(temporary, file);
  }
}

function view(agent: AgentRecord, run: Run): AgentView {
  return {
    id: agent.id,
    title: agent.title,
    status: run.status,
    runId: run.id,
    ...(agent.pushed && agent.branch ? { branch: agent.branch } : {}),
    ...(agent.prUrl ? { prUrl: agent.prUrl } : {}),
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

function parseLine(line: string): { type?: string; is_error?: boolean } | undefined {
  try {
    const value: unknown = JSON.parse(line);
    return value && typeof value === "object" ? value : undefined;
  } catch {
    return undefined;
  }
}

function lastLine(output: string) {
  return output.trim().split("\n").at(-1)?.trim() ?? "";
}

/** Stops the whole process group: the agent's own commands and servers go with it. */
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
