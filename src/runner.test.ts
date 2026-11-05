import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import type { Server } from "node:http";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import pg from "pg";
import { afterEach, beforeEach, describe, expect, inject, it } from "vitest";
import { Store } from "./db.ts";
import { createHandler } from "./http.ts";
import type { ConversationView } from "./runner.ts";
import { ConversationRunner } from "./runner.ts";

// Quiet by default; run `LOG_LEVEL=info npm test` to see the service's log.
process.env.LOG_LEVEL ??= "silent";

const REPOSITORY = "https://github.com/example/demo";

// Stands in for Claude Code: reads one stream-json user message, then behaves as the prompt says.
const FAKE_CLAUDE = `
const fs = require("node:fs");
fs.appendFileSync(process.env.FAKE_CLAUDE_LOG, JSON.stringify(process.argv.slice(2)) + "\\n");
let input = "";
process.stdin.on("data", (chunk) => (input += chunk));
process.stdin.on("end", () => {
  const text = JSON.parse(input.trim()).message.content[0].text;
  // Like Claude Code refusing --dangerously-skip-permissions as root: no session, no events.
  if (text.includes("refuse")) {
    console.error("--dangerously-skip-permissions cannot be used with root/sudo privileges for security reasons");
    process.exit(1);
  }
  console.log(JSON.stringify({ type: "system", subtype: "init" }));
  if (text.includes("hang")) return setInterval(() => undefined, 1000);
  if (text.includes("fail")) {
    console.log(JSON.stringify({ type: "result", subtype: "error_during_execution", is_error: true }));
    process.exit(1);
  }
  fs.writeFileSync("change-" + Date.now() + ".txt", text);
  console.log(JSON.stringify({
    type: "result", subtype: "success", is_error: false, total_cost_usd: 0.25,
    modelUsage: { "claude-opus-5-5": { inputTokens: 1200, outputTokens: 300, costUSD: 0.25 } },
  }));
});
`;

const FAKE_GH = `
if (process.argv[2] === "pr" && process.argv[3] === "create") console.log("${REPOSITORY}/pull/7");
else process.exit(1);
`;

let dir: string;
let server: Server;
let runner: ConversationRunner;
let store: Store;
let base: string;
let origin: string;

function script(name: string, source: string) {
  const js = path.join(dir, `${name}.cjs`);
  writeFileSync(js, source);
  const bin = path.join(dir, name);
  writeFileSync(bin, `#!/bin/sh\nexec "${process.execPath}" "${js}" "$@"\n`);
  chmodSync(bin, 0o755);
  return bin;
}

function git(cwd: string, ...args: string[]) {
  return execFileSync("git", args, {
    cwd,
    env: { ...process.env, ...identity },
    stdio: "pipe",
  }).toString();
}

const identity = {
  GIT_AUTHOR_NAME: "Test",
  GIT_AUTHOR_EMAIL: "test@example.com",
  GIT_COMMITTER_NAME: "Test",
  GIT_COMMITTER_EMAIL: "test@example.com",
};

async function start(publicUrl?: string) {
  store = new Store(inject("databaseUrl"));
  await store.migrate();
  runner = new ConversationRunner({
    store,
    ...(publicUrl ? { publicUrl } : {}),
    dataDir: path.join(dir, "data"),
    claudeCommand: script("claude", FAKE_CLAUDE),
    ghCommand: script("gh", FAKE_GH),
    env: {
      ...process.env,
      ...identity,
      FAKE_CLAUDE_LOG: path.join(dir, "claude.log"),
      // Clone the example repository from a local origin instead of the network.
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: `url.${origin}.insteadOf`,
      GIT_CONFIG_VALUE_0: REPOSITORY,
    },
  });
  await runner.load();
  server = createServer(createHandler(runner));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

/** Like a service restart: everything the new runner knows comes from the database. */
async function restart(publicUrl?: string) {
  await stop();
  await start(publicUrl);
}

async function stop() {
  await runner.idle();
  await new Promise((resolve) => server.close(resolve));
  await store.close();
}

/** Runs SQL against the test database directly. */
async function sql(text: string, values: unknown[] = []) {
  const client = new pg.Client({ connectionString: inject("databaseUrl") });
  await client.connect();
  try {
    return (await client.query(text, values)).rows;
  } finally {
    await client.end();
  }
}

/** The arguments of every `claude` invocation so far, in order. */
function claudeCalls() {
  return readFileSync(path.join(dir, "claude.log"), "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as string[]);
}

async function call(method: string, pathname: string, body?: unknown) {
  const response = await fetch(`${base}${pathname}`, {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = (await response.json()) as Partial<ConversationView> & { code?: string };
  return { status: response.status, body: json };
}

beforeEach(async () => {
  dir = mkdtempSync(path.join(os.tmpdir(), "claude-code-runner-"));
  origin = path.join(dir, "origin.git");
  const seed = path.join(dir, "seed");
  git(dir, "init", "--bare", "--initial-branch=main", origin);
  git(dir, "init", "--initial-branch=main", seed);
  writeFileSync(path.join(seed, "README.md"), "demo\n");
  git(seed, "add", ".");
  git(seed, "commit", "-m", "init");
  git(seed, "push", origin, "main");
  // Applies the schema, then every test starts from empty tables.
  const setup = new Store(inject("databaseUrl"));
  await setup.migrate();
  await setup.close();
  await sql("TRUNCATE conversations, runs, events, tool_calls");
  await start();
});

afterEach(async () => {
  await stop();
  rmSync(dir, { recursive: true, force: true });
});

describe("claude code runner", () => {
  it("links each run to its conversation page when APP_URL is set", async () => {
    expect((await call("PUT", "/conversations/plain", { prompt: "hi" })).body.url).toBeUndefined();
    await restart("https://coder.example.com/@me/ws/apps/claude-code-runner/");
    const launched = await call("PUT", "/conversations/linked", { prompt: "Say <hi>" });
    expect(launched.body.url).toBe(
      `https://coder.example.com/@me/ws/apps/claude-code-runner/ui/conversations/linked`,
    );
    await runner.idle();
    const page = await fetch(`${base}/ui/conversations/linked`);
    expect(page.status).toBe(200);
    expect(page.headers.get("content-type")).toContain("text/html");
    const html = await page.text();
    expect(html).toContain("Say &#60;hi&#62;");
    expect(html).toContain("finished");
    // The left sidebar lists every conversation, the right one sums this one up.
    expect(html).toContain('href="./plain"');
    expect(html).toContain('href="./linked" class="current"');
    expect(html).toContain("By model");
    expect(html).toContain("Opus 5.5");
    expect(html).toContain("$0.25");
    expect((await call("GET", "/ui/conversations/missing")).body.code).toBe("not_found");
    expect((await fetch(`${base}/ui/agents/linked`)).status).toBe(200);
    // Links handed out before the run id was dropped still open the page.
    expect((await fetch(`${base}/ui/conversations/linked?run=old`)).status).toBe(200);

    // With no id, the page is the conversation list; links resolve against the URL served.
    const list = await fetch(`${base}/ui/conversations`);
    expect(list.status).toBe(200);
    expect(list.headers.get("content-type")).toContain("text/html");
    const listHtml = await list.text();
    expect(listHtml).toContain('href="conversations/plain"');
    expect(listHtml).toContain('href="conversations/linked"');
    expect(listHtml).not.toContain('class="current"');
    expect(await (await fetch(`${base}/ui/conversations/`)).text()).toContain('href="./linked"');
    expect(await (await fetch(`${base}/ui/agents`)).text()).toContain('href="agents/linked"');
  });

  it("launches idempotently, pushes the branch and opens one pull request", async () => {
    const request = { prompt: "Add a file\nwith details", repository: REPOSITORY, openPr: true };
    const first = await call("PUT", "/agents/agent-1", request);
    expect(first).toMatchObject({ status: 200, body: { status: "running", title: "Add a file" } });
    expect((await call("PUT", "/agents/agent-1", request)).body.runId).toBe(first.body.runId);
    await runner.idle();
    const done = await call("GET", "/agents/agent-1");
    // Rakazo uses the /agents alias; both paths reach the same conversation.
    expect((await call("GET", "/conversations/agent-1")).body).toEqual(done.body);
    expect(done.body).toMatchObject({
      status: "finished",
      branch: "agent/agent-1",
      prUrl: `${REPOSITORY}/pull/7`,
    });
    expect(git(origin, "log", "--format=%s", "agent/agent-1")).toContain("Add a file");

    const followup = await call("POST", "/agents/agent-1/runs", { prompt: "And another" });
    expect(followup.body.runId).not.toBe(first.body.runId);
    await runner.idle();
    expect((await call("GET", `/agents/agent-1/runs/${first.body.runId}`)).body.status).toBe(
      "finished",
    );
    expect(git(origin, "log", "--format=%s", "agent/agent-1")).toContain("Add a file");
    expect(git(origin, "ls-tree", "--name-only", "agent/agent-1").split("\n")).toHaveLength(4);

    const calls = readFileSync(path.join(dir, "claude.log"), "utf8").trim().split("\n");
    const [launchArgs, replyArgs] = calls.map((line) => JSON.parse(line) as string[]);
    const session = launchArgs![launchArgs!.indexOf("--session-id") + 1];
    expect(replyArgs![replyArgs!.indexOf("--resume") + 1]).toBe(session);
  });

  it("refuses a reply while a run is going and cancels it", async () => {
    const launched = await call("PUT", "/conversations/busy", { prompt: "hang" });
    expect((await call("POST", "/conversations/busy/runs", { prompt: "More" })).status).toBe(409);
    const cancelled = await call("POST", `/conversations/busy/runs/${launched.body.runId}/cancel`);
    expect(cancelled.body.status).toBe("cancelled");
    expect(
      (await call("POST", `/conversations/busy/runs/${launched.body.runId}/cancel`)).body.status,
    ).toBe("cancelled");
    expect((await call("POST", "/conversations/busy/runs", { prompt: "Again" })).status).toBe(200);
  });

  it("reports failures and does not publish them", async () => {
    await call("PUT", "/conversations/broken", { prompt: "fail", repository: REPOSITORY, openPr: true });
    await runner.idle();
    const result = await call("GET", "/conversations/broken");
    expect(result.body.status).toBe("failed");
    expect(result.body.branch).toBeUndefined();
    expect(result.body.prUrl).toBeUndefined();
  });

  it("reports why Claude Code failed and starts the session again after it refused", async () => {
    await call("PUT", "/conversations/refused", { prompt: "refuse" });
    await runner.idle();
    const failed = await call("GET", "/conversations/refused");
    expect(failed.body.status).toBe("failed");
    expect(failed.body.error).toBe(
      "Claude Code failed: --dangerously-skip-permissions cannot be used with root/sudo privileges for security reasons",
    );

    // Claude never created the session, so the follow-up must create it, not resume it.
    await call("POST", "/conversations/refused/runs", { prompt: "Try again" });
    await runner.idle();
    expect((await call("GET", "/conversations/refused")).body.status).toBe("finished");
    const [first, second] = claudeCalls();
    const session = first![first!.indexOf("--session-id") + 1];
    expect(second).toContain("--session-id");
    expect(second).not.toContain("--resume");
    expect(second![second!.indexOf("--session-id") + 1]).toBe(session);
  });

  it("repairs a record that claims a session Claude never created", async () => {
    await call("PUT", "/conversations/stuck", { prompt: "refuse" });
    await runner.idle();
    // What older versions stored: sessionStarted set as soon as claude was spawned.
    await sql("UPDATE conversations SET session_started = true WHERE id = 'stuck'");
    await restart();

    await call("POST", "/conversations/stuck/runs", { prompt: "Try again" });
    await runner.idle();
    expect(claudeCalls()[1]).toContain("--session-id");
    expect((await call("GET", "/conversations/stuck")).body.status).toBe("finished");
  });

  it("uses Claude Code's result text or subtype as the error", async () => {
    await call("PUT", "/conversations/broken-2", { prompt: "fail" });
    await runner.idle();
    expect((await call("GET", "/conversations/broken-2")).body.error).toBe(
      "Claude Code failed: error_during_execution",
    );
  });

  it("marks a run interrupted by a restart as failed", async () => {
    await call("PUT", "/conversations/restart", { prompt: "hang" });
    const otherStore = new Store(inject("databaseUrl"));
    const restarted = new ConversationRunner({
      store: otherStore,
      dataDir: path.join(dir, "data"),
      claudeCommand: "claude",
      ghCommand: "gh",
    });
    await restarted.load();
    expect(restarted.get("restart")?.status).toBe("failed");
    await otherStore.close();
    const run = runner.get("restart")!.runId;
    await call("POST", `/conversations/restart/runs/${run}/cancel`);
  });

  it("keeps conversations only in the database", async () => {
    const launched = await call("PUT", "/conversations/kept", {
      prompt: "Add a file",
      repository: REPOSITORY,
      openPr: true,
    });
    await runner.idle();
    await call("POST", "/conversations/kept/runs", { prompt: "refuse" });
    await runner.idle();

    // On disk there is only the checkout Claude works in.
    expect(readdirSync(path.join(dir, "data"))).toEqual(["work"]);

    expect(await sql("SELECT id, title, session_started, pushed, pr_url, base_commit IS NOT NULL AS has_base FROM conversations")).toEqual([
      { id: "kept", title: "Add a file", session_started: true, pushed: true, pr_url: `${REPOSITORY}/pull/7`, has_base: true },
    ]);
    const runs = await sql("SELECT seq, status, prompt, error, stderr FROM runs ORDER BY seq");
    expect(runs).toMatchObject([
      { seq: 1, status: "finished", prompt: "Add a file", error: null },
      { seq: 2, status: "failed", prompt: "refuse", error: expect.stringContaining("root/sudo") },
    ]);
    expect(runs[1]!.stderr).toContain("--dangerously-skip-permissions cannot be used");
    expect(await sql("SELECT type, subtype FROM events ORDER BY seq")).toEqual([
      { type: "system", subtype: "init" },
      { type: "result", subtype: "success" },
    ]);

    // A restarted service knows everything from the database alone.
    await restart();
    expect((await call("GET", `/conversations/kept/runs/${launched.body.runId}`)).body).toMatchObject({
      status: "finished",
      branch: "agent/kept",
      prUrl: `${REPOSITORY}/pull/7`,
    });
    expect((await call("GET", "/conversations/kept")).body.status).toBe("failed");
    const html = await (await fetch(`${base}/ui/conversations/kept`)).text();
    expect(html).toContain("Run 2");
    expect(html).toContain("success");
  });

  it("starts nothing when the database cannot store the launch", async () => {
    await store.close();
    expect(await call("PUT", "/conversations/lost", { prompt: "hi" })).toEqual({
      status: 500,
      body: { code: "internal" },
    });
    expect((await call("GET", "/conversations/lost")).status).toBe(404);
    expect(() => claudeCalls()).toThrow();
  });

  it("validates requests and reports unknown conversations", async () => {
    expect((await call("PUT", "/conversations/bad", { prompt: "" })).status).toBe(400);
    expect(
      (await call("PUT", "/conversations/bad", { prompt: "x", repository: "file:///etc" })).status,
    ).toBe(400);
    expect((await call("GET", "/conversations/missing")).body).toEqual({ code: "not_found" });
    expect((await call("GET", "/conversations/bad%2F..")).status).toBe(404);
  });
});
