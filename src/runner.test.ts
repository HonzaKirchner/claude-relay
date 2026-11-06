import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

/** Checked out under the root as `demo`; launches name it unless they say otherwise. */
const REPOSITORY = "https://github.com/example/demo";
/** A second repository, checked out under the root as `other`. */
const OTHER = "https://github.com/example/other";

// Stands in for Claude Code: reads stream-json user messages line by line, behaves as the first
// one says, and exits once stdin is closed (and nothing else keeps it going).
const FAKE_CLAUDE = `
const fs = require("node:fs");
fs.appendFileSync(process.env.FAKE_CLAUDE_LOG, JSON.stringify(process.argv.slice(2)) + "\\n");
const say = (event) => console.log(JSON.stringify(event));
const reply = (text) => say({ type: "assistant", message: { content: [{ type: "text", text }] } });
let first = true;
let onMessage = () => undefined;
require("node:readline").createInterface({ input: process.stdin }).on("line", (line) => {
  if (!line.trim()) return;
  const text = JSON.parse(line).message.content[0].text;
  if (!first) return onMessage(text);
  first = false;
  start(text);
});
function start(text) {
  // Like Claude Code refusing --dangerously-skip-permissions as root: no session, no events.
  if (text.includes("refuse")) {
    console.error("--dangerously-skip-permissions cannot be used with root/sudo privileges for security reasons");
    process.exit(1);
  }
  console.log(JSON.stringify({ type: "system", subtype: "init" }));
  if (text.includes("hang")) return setInterval(() => undefined, 1000);
  // Prints a tool call, then waits for the test to create the gate file before finishing it.
  // Takes a message sent mid-turn into the turn it is on: one result for both.
  if (text.includes("merge")) {
    reply("Working on it");
    onMessage = (steer) => {
      reply("Steered: " + steer);
      say({ type: "result", subtype: "success", is_error: false });
    };
    return;
  }
  // Answers every message with a turn of its own, the first only once the gate file exists.
  if (text.includes("turns")) {
    const queue = [];
    let busy = true;
    const answer = (message) => {
      reply("Echo: " + message);
      say({ type: "result", subtype: "success", is_error: false });
    };
    onMessage = (message) => (busy ? queue.push(message) : answer(message));
    const wait = setInterval(() => {
      if (!fs.existsSync(process.env.FAKE_CLAUDE_GATE)) return;
      clearInterval(wait);
      answer("first");
      busy = false;
      queue.splice(0).forEach(answer);
    }, 20);
    return;
  }
  if (text.includes("stream")) {
    say({ type: "assistant", message: { content: [
      { type: "text", text: "Looking **around**" },
      { type: "tool_use", id: "toolu_1", name: "Bash", input: { command: "npm test", description: "Run the tests" } },
    ] } });
    const wait = setInterval(() => {
      if (!fs.existsSync(process.env.FAKE_CLAUDE_GATE)) return;
      clearInterval(wait);
      say({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "all 12 passed" }] } });
      say({ type: "assistant", message: { content: [{ type: "text", text: "Tests pass." }] } });
      say({ type: "result", subtype: "success", is_error: false, total_cost_usd: 0.1 });
    }, 20);
    return;
  }
  if (text.includes("fail")) {
    console.log(JSON.stringify({ type: "result", subtype: "error_during_execution", is_error: true }));
    process.exit(1);
  }
  // Leaves a change behind and fails, like a run cut off half way.
  if (text.includes("dirty")) {
    fs.writeFileSync("leftover.txt", "work in progress");
    console.log(JSON.stringify({ type: "result", subtype: "error_during_execution", is_error: true }));
    process.exit(1);
  }
  fs.writeFileSync("change-" + Date.now() + ".txt", text);
  console.log(JSON.stringify({
    type: "result", subtype: "success", is_error: false, total_cost_usd: 0.25,
    result: "Done: " + text.split("\\n")[0],
    modelUsage: { "claude-opus-5-5": { inputTokens: 1200, outputTokens: 300, costUSD: 0.25 } },
  }));
}
`;

// Opens the PR in the repository it runs in: the checkouts are named after their repositories.
const FAKE_GH = `
if (process.argv[2] === "pr" && process.argv[3] === "create")
  console.log("https://github.com/example/" + require("node:path").basename(process.cwd()) + "/pull/7");
else process.exit(1);
`;

let dir: string;
let server: Server;
let runner: ConversationRunner;
let store: Store;
let base: string;
/** The bare origins of the two repositories. */
let origin: string;
let otherOrigin: string;
/** Holds the checkouts, as `~/src` does in the workspace. */
let root: string;
/** The checkout of `REPOSITORY`, `<root>/demo`, and of `OTHER`, `<root>/other`. */
let checkout: string;
let other: string;

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

interface StartOptions {
  publicUrl?: string;
  baseBranch?: string;
  claudeModel?: string;
  root?: string;
}

async function start(options: StartOptions = {}) {
  store = new Store(inject("databaseUrl"));
  await store.migrate();
  runner = new ConversationRunner({
    store,
    root,
    ...options,
    claudeCommand: script("claude", FAKE_CLAUDE),
    ghCommand: script("gh", FAKE_GH),
    steerIdleMs: 300,
    env: {
      ...process.env,
      ...identity,
      FAKE_CLAUDE_LOG: path.join(dir, "claude.log"),
      FAKE_CLAUDE_GATE: path.join(dir, "gate"),
      // The checkouts' origins are the example repositories' URLs; git reaches the local origins instead.
      GIT_CONFIG_COUNT: "2",
      GIT_CONFIG_KEY_0: `url.${origin}.insteadOf`,
      GIT_CONFIG_VALUE_0: REPOSITORY,
      GIT_CONFIG_KEY_1: `url.${otherOrigin}.insteadOf`,
      GIT_CONFIG_VALUE_1: OTHER,
    },
  });
  await runner.load();
  server = createServer(createHandler(runner, { rakazoUrl: "https://rakazo.example.com/app" }));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

/** Like a service restart: everything the new runner knows comes from the database. */
async function restart(options: StartOptions = {}) {
  await stop();
  await start(options);
}

/** The files on a branch of the origin. */
function filesOn(branch: string, from = origin) {
  return git(from, "ls-tree", "--name-only", branch).trim().split("\n").sort();
}

/** A bare repository with one commit on `main`, and a clone of it under the root whose origin is `url`. */
function repository(name: string, url: string) {
  const bare = path.join(dir, `${name}.git`);
  const seed = path.join(dir, `${name}-seed`);
  git(dir, "init", "--bare", "--initial-branch=main", bare);
  git(dir, "init", "--initial-branch=main", seed);
  writeFileSync(path.join(seed, "README.md"), `${name}\n`);
  git(seed, "add", ".");
  git(seed, "commit", "-m", "init");
  git(seed, "push", bare, "main");
  // As the Coder template has it: cloned from the repository, named after it.
  git(root, "clone", "--quiet", bare, name);
  git(path.join(root, name), "remote", "set-url", "origin", url);
  return { bare, seed };
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

interface Message {
  event: string;
  data: { seq?: number; messages?: number; ops?: Array<{ op: string; id?: string; target?: string; html: string }> };
}

/** Opens the page's event stream; `next` resolves with each message in turn. */
async function openStream(pathname: string) {
  const response = await fetch(`${base}${pathname}`);
  const reader = response.body!.pipeThrough(new TextDecoderStream()).getReader();
  let buffered = "";
  return {
    response,
    async next(): Promise<Message | undefined> {
      for (;;) {
        const end = buffered.indexOf("\n\n");
        if (end >= 0) {
          const frame = buffered.slice(0, end);
          buffered = buffered.slice(end + 2);
          const field = (name: string) => frame.split("\n").find((line) => line.startsWith(`${name}: `))?.slice(name.length + 2);
          return { event: field("event")!, data: JSON.parse(field("data") ?? "{}") };
        }
        const { value, done } = await reader.read();
        if (done) return undefined;
        buffered += value;
      }
    },
    /** Reads messages until one matches. */
    async until(match: (message: Message) => boolean): Promise<Message> {
      for (;;) {
        const message = await this.next();
        if (!message) throw new Error("stream ended");
        if (match(message)) return message;
      }
    },
    close: () => reader.cancel(),
  };
}

/** Polls until the conversation's latest run has ended; `runner.idle()` would wait for every run. */
async function finished(id: string) {
  for (;;) {
    const { body } = await call("GET", `/conversations/${id}`);
    if (body.status !== "running") return body;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

/** The arguments of every `claude` invocation so far, in order. */
function claudeCalls() {
  return readFileSync(path.join(dir, "claude.log"), "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as string[]);
}

/** A launch (PUT) names `REPOSITORY` unless the body says otherwise (`repository: undefined` names none). */
async function call(method: string, pathname: string, body?: unknown) {
  const sent = method === "PUT" && body !== undefined ? { repository: REPOSITORY, ...(body as object) } : body;
  const response = await fetch(`${base}${pathname}`, {
    method,
    headers: { "content-type": "application/json" },
    body: sent === undefined ? undefined : JSON.stringify(sent),
  });
  const json = (await response.json()) as Partial<ConversationView> & { code?: string };
  return { status: response.status, body: json };
}

beforeEach(async () => {
  dir = mkdtempSync(path.join(os.tmpdir(), "claude-code-runner-"));
  root = path.join(dir, "root");
  mkdirSync(root);
  const demo = repository("demo", REPOSITORY);
  origin = demo.bare;
  checkout = path.join(root, "demo");
  // A second branch, for conversations that name their base.
  git(demo.seed, "checkout", "-b", "release");
  writeFileSync(path.join(demo.seed, "RELEASE.md"), "release\n");
  git(demo.seed, "add", ".");
  git(demo.seed, "commit", "-m", "release");
  git(demo.seed, "push", origin, "release");
  otherOrigin = repository("other", OTHER).bare;
  other = path.join(root, "other");
  // Applies the schema, then every test starts from empty tables.
  const setup = new Store(inject("databaseUrl"));
  await setup.migrate();
  await setup.close();
  await sql("TRUNCATE conversations, runs, run_messages, events, tool_calls");
  await start();
});

afterEach(async () => {
  await stop();
  rmSync(dir, { recursive: true, force: true });
});

describe("claude code runner", () => {
  it("links each run to its conversation page when APP_URL is set", async () => {
    expect((await call("PUT", "/conversations/plain", { prompt: "hi" })).body.url).toBeUndefined();
    await restart({ publicUrl: "https://coder.example.com/@me/ws/apps/claude/" });
    const launched = await call("PUT", "/conversations/linked", { prompt: "Say <hi>" });
    expect(launched.body.url).toBe(
      `https://coder.example.com/@me/ws/apps/claude/ui/conversations/linked`,
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
    // Its head names the service and links back to Rakazo.
    expect(html).toContain("Rakazo code");
    expect(html).toContain('href="https://rakazo.example.com/app"');
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
    expect(listHtml).toContain("<title>Rakazo code</title>");
    expect(listHtml).toContain('href="https://rakazo.example.com/app"');
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
      latestRunId: first.body.runId,
      summary: "Done: Add a file",
    });
    expect(git(origin, "log", "--format=%s", "agent/agent-1")).toContain("Add a file");
    // The pushed branch links to the branch on GitHub.
    expect(await (await fetch(`${base}/ui/conversations/agent-1`)).text()).toContain(
      `<a href="${REPOSITORY}/tree/agent/agent-1" target="_blank" rel="noopener"><code>agent/agent-1</code></a>`,
    );

    const followup =await call("POST", "/agents/agent-1/runs", { prompt: "And another" });
    expect(followup.body.runId).not.toBe(first.body.runId);
    await runner.idle();
    // An older run keeps its own summary but points at the latest run.
    expect((await call("GET", `/agents/agent-1/runs/${first.body.runId}`)).body).toMatchObject({
      status: "finished",
      runId: first.body.runId,
      latestRunId: followup.body.runId,
      summary: "Done: Add a file",
    });
    expect((await call("GET", "/agents/agent-1")).body).toMatchObject({
      runId: followup.body.runId,
      latestRunId: followup.body.runId,
      summary: "Done: And another",
    });
    // The summary comes back from the database after a restart.
    await restart();
    expect((await call("GET", "/agents/agent-1")).body.summary).toBe("Done: And another");
    expect(git(origin, "log", "--format=%s", "agent/agent-1")).toContain("Add a file");
    expect(filesOn("agent/agent-1")).toHaveLength(3);
    // The work happened in the repository's checkout, which is left on the conversation's branch.
    expect(git(checkout, "rev-parse", "--abbrev-ref", "HEAD").trim()).toBe("agent/agent-1");
    expect(git(checkout, "status", "--porcelain")).toBe("");

    const calls = readFileSync(path.join(dir, "claude.log"), "utf8").trim().split("\n");
    const [launchArgs, replyArgs] = calls.map((line) => JSON.parse(line) as string[]);
    const session = launchArgs![launchArgs!.indexOf("--session-id") + 1];
    expect(replyArgs![replyArgs!.indexOf("--resume") + 1]).toBe(session);
    expect(launchArgs![launchArgs!.indexOf("--append-system-prompt") + 1]).toContain("branch agent/agent-1");
  });

  it("runs one conversation at a time per checkout and cancels a run", async () => {
    const launched = await call("PUT", "/conversations/busy", { prompt: "hang" });
    // One checkout per repository: while a run is going in it, nothing else starts there.
    expect(await call("POST", "/conversations/busy/runs", { prompt: "More" })).toEqual({
      status: 409,
      body: { code: "busy", reason: "locked", conversation: "busy" },
    });
    expect(await call("PUT", "/conversations/other", { prompt: "hi" })).toEqual({
      status: 409,
      body: { code: "busy", reason: "locked", conversation: "busy" },
    });
    expect((await call("GET", "/conversations/other")).status).toBe(404);
    const cancelled = await call("POST", `/conversations/busy/runs/${launched.body.runId}/cancel`);
    expect(cancelled.body.status).toBe("cancelled");
    expect(
      (await call("POST", `/conversations/busy/runs/${launched.body.runId}/cancel`)).body.status,
    ).toBe("cancelled");
    // Once it has stopped, the checkout is free for anyone.
    expect((await call("PUT", "/conversations/other", { prompt: "hi" })).status).toBe(200);
    await runner.idle();
    expect((await call("GET", "/conversations/other")).body.status).toBe("finished");
    expect((await call("POST", "/conversations/busy/runs", { prompt: "Again" })).status).toBe(200);
    await runner.idle();
    expect((await call("GET", "/conversations/busy")).body.status).toBe("finished");
  });

  it("works in the checkout of the launch's repository, side by side with other repositories", async () => {
    const demoRun = await call("PUT", "/conversations/demo-1", { prompt: "hang" });
    // The other repository's checkout is free, so its run goes while demo's is going.
    const otherRun = await call("PUT", "/conversations/other-1", { prompt: "hang", repository: OTHER });
    expect(otherRun.body.status).toBe("running");
    // Each checkout refuses with the conversation holding it.
    expect(await call("PUT", "/conversations/demo-2", { prompt: "hi" })).toEqual({
      status: 409,
      body: { code: "busy", reason: "locked", conversation: "demo-1" },
    });
    expect(await call("PUT", "/conversations/other-2", { prompt: "hi", repository: `${OTHER}.git` })).toEqual({
      status: 409,
      body: { code: "busy", reason: "locked", conversation: "other-1" },
    });
    expect((await call("POST", "/conversations/demo-1/runs", { prompt: "more" })).body).toMatchObject({ conversation: "demo-1" });
    await call("POST", `/conversations/other-1/runs/${otherRun.body.runId}/cancel`);

    // `.git` and case are not a different repository.
    await call("PUT", "/conversations/other-2", { prompt: "Add a file", repository: "https://github.com/Example/other.git", openPr: true });
    expect(await finished("other-2")).toMatchObject({
      status: "finished",
      branch: "agent/other-2",
      prUrl: `${OTHER}/pull/7`,
    });
    expect(filesOn("agent/other-2", otherOrigin)).toEqual(["README.md", expect.stringMatching(/^change-/)]);
    expect(git(other, "rev-parse", "--abbrev-ref", "HEAD").trim()).toBe("agent/other-2");
    expect(await sql("SELECT repository FROM conversations WHERE id = 'other-2'")).toEqual([{ repository: "https://github.com/Example/other" }]);
    // Demo's checkout was never touched: still on its own running conversation's branch.
    expect(git(checkout, "rev-parse", "--abbrev-ref", "HEAD").trim()).toBe("agent/demo-1");
    expect((await call("GET", "/conversations/demo-1")).body.status).toBe("running");
    await call("POST", `/conversations/demo-1/runs/${demoRun.body.runId}/cancel`);
    expect(() => git(origin, "rev-parse", "--verify", "agent/other-2")).toThrow();
  });

  it("refuses a launch for a repository that is not checked out under the root", async () => {
    expect(await call("PUT", "/conversations/missing", { prompt: "hi", repository: "https://github.com/example/missing.git" })).toEqual({
      status: 400,
      body: { code: "invalid", reason: "no_checkout", path: path.join(root, "missing"), repository: "https://github.com/example/missing" },
    });
    expect((await call("GET", "/conversations/missing")).status).toBe(404);
    // A directory that is no checkout, and a checkout of some other repository under that name.
    mkdirSync(path.join(root, "plain"));
    expect((await call("PUT", "/conversations/plain", { prompt: "hi", repository: "https://github.com/example/plain" })).body).toEqual({
      code: "invalid",
      reason: "no_checkout",
      path: path.join(root, "plain"),
      repository: "https://github.com/example/plain",
    });
    git(root, "clone", "--quiet", origin, "wrong");
    git(path.join(root, "wrong"), "remote", "set-url", "origin", REPOSITORY);
    expect((await call("PUT", "/conversations/wrong", { prompt: "hi", repository: "https://github.com/example/wrong" })).body).toEqual({
      code: "invalid",
      reason: "no_checkout",
      path: path.join(root, "wrong"),
      repository: "https://github.com/example/wrong",
      found: REPOSITORY,
    });
    // Without a repository, the root itself would have to be a checkout.
    expect(await call("PUT", "/conversations/none", { prompt: "hi", repository: undefined })).toEqual({
      status: 400,
      body: { code: "invalid", reason: "no_checkout", path: root },
    });
    expect(() => claudeCalls()).toThrow();

    // A follow-up needs the checkout too. Cloned again, the conversation goes on from its pushed branch.
    await call("PUT", "/conversations/gone", { prompt: "First", repository: OTHER });
    await runner.idle();
    rmSync(other, { recursive: true, force: true });
    expect((await call("POST", "/conversations/gone/runs", { prompt: "Second" })).body).toMatchObject({
      code: "invalid",
      reason: "no_checkout",
      path: other,
      repository: OTHER,
    });
    expect((await call("GET", "/conversations/gone")).body.status).toBe("finished");
    git(root, "clone", "--quiet", otherOrigin, "other");
    git(other, "remote", "set-url", "origin", OTHER);
    await call("POST", "/conversations/gone/runs", { prompt: "Second" });
    await runner.idle();
    expect((await call("GET", "/conversations/gone")).body.status).toBe("finished");
    expect(filesOn("agent/gone", otherOrigin)).toHaveLength(3);
  });

  it("works in the root itself when it is the checkout", async () => {
    // A workspace with one checkout: launches with and without that repository work in it.
    await restart({ root: checkout });
    await call("PUT", "/conversations/bare", { prompt: "No repository", repository: undefined });
    await runner.idle();
    await call("PUT", "/conversations/named", { prompt: "Named" });
    await runner.idle();
    expect(await sql("SELECT id, repository, pushed FROM conversations ORDER BY id")).toEqual([
      { id: "bare", repository: REPOSITORY, pushed: true },
      { id: "named", repository: REPOSITORY, pushed: true },
    ]);
    expect(filesOn("agent/bare")).toHaveLength(2);
    expect(git(checkout, "rev-parse", "--abbrev-ref", "HEAD").trim()).toBe("agent/named");
    expect((await call("PUT", "/conversations/elsewhere", { prompt: "hi", repository: OTHER })).body).toEqual({
      code: "invalid",
      reason: "no_checkout",
      path: path.join(checkout, "other"),
      repository: OTHER,
    });
  });

  it("refuses runs while the checkout has leftovers, unless they are the conversation's own", async () => {
    await call("PUT", "/conversations/messy", { prompt: "dirty" });
    await runner.idle();
    expect((await call("GET", "/conversations/messy")).body).toMatchObject({ status: "failed" });
    expect(git(checkout, "status", "--porcelain")).toContain("leftover.txt");

    // Another conversation would start on those changes: refused, and not created.
    expect(await call("PUT", "/conversations/next", { prompt: "hi" })).toEqual({
      status: 409,
      body: { code: "busy", reason: "dirty", branch: "agent/messy" },
    });
    expect((await call("GET", "/conversations/next")).status).toBe(404);

    // The conversation they belong to goes on from them and publishes them with its work.
    await call("POST", "/conversations/messy/runs", { prompt: "Clean up" });
    await runner.idle();
    expect((await call("GET", "/conversations/messy")).body).toMatchObject({ status: "finished", branch: "agent/messy" });
    expect(filesOn("agent/messy")).toEqual(["README.md", expect.stringMatching(/^change-/), "leftover.txt"]);

    // Now the next conversation starts, from the origin's main and not from the previous branch.
    expect((await call("PUT", "/conversations/next", { prompt: "hi" })).status).toBe(200);
    await runner.idle();
    expect(filesOn("agent/next")).toEqual(["README.md", expect.stringMatching(/^change-/)]);
    expect(git(checkout, "rev-parse", "--abbrev-ref", "HEAD").trim()).toBe("agent/next");

    // A person's own changes in the checkout are refused as well, whatever branch they are on.
    git(checkout, "checkout", "--quiet", "main");
    writeFileSync(path.join(checkout, "README.md"), "edited by hand\n");
    expect(await call("POST", "/conversations/next/runs", { prompt: "more" })).toEqual({
      status: 409,
      body: { code: "busy", reason: "dirty", branch: "main" },
    });
  });

  it("starts a conversation from the named base branch", async () => {
    expect((await call("PUT", "/conversations/bad", { prompt: "x", baseBranch: "-x" })).status).toBe(400);
    expect((await call("PUT", "/conversations/bad", { prompt: "x", baseBranch: "a b" })).status).toBe(400);
    await call("PUT", "/conversations/rel", { prompt: "On release", baseBranch: "release" });
    await runner.idle();
    expect(filesOn("agent/rel")).toEqual(["README.md", "RELEASE.md", expect.stringMatching(/^change-/)]);
    expect(await sql("SELECT base_branch FROM conversations WHERE id = 'rel'")).toEqual([{ base_branch: "release" }]);

    // The service can have a base branch of its own; the launch's still wins.
    await restart({ baseBranch: "release" });
    await call("PUT", "/conversations/rel-2", { prompt: "Also on release" });
    await runner.idle();
    expect(filesOn("agent/rel-2")).toContain("RELEASE.md");
    await call("PUT", "/conversations/main-2", { prompt: "On main", baseBranch: "main" });
    await runner.idle();
    expect(filesOn("agent/main-2")).not.toContain("RELEASE.md");
  });

  it("runs claude with the configured model", async () => {
    await call("PUT", "/conversations/default-model", { prompt: "Add a file" });
    await runner.idle();
    expect(claudeCalls()[0]).not.toContain("--model");

    await restart({ claudeModel: "opus" });
    await call("POST", "/conversations/default-model/runs", { prompt: "And another" });
    await runner.idle();
    const [, reply] = claudeCalls();
    expect(reply![reply!.indexOf("--model") + 1]).toBe("opus");
  });

  it("restores a conversation's branch from the origin when the checkout lost it", async () => {
    await call("PUT", "/conversations/old", { prompt: "First" });
    await runner.idle();
    // As after moving to a new checkout: the branch is only on the origin.
    git(checkout, "checkout", "--quiet", "main");
    git(checkout, "branch", "-D", "agent/old");
    await call("POST", "/conversations/old/runs", { prompt: "Second" });
    await runner.idle();
    expect((await call("GET", "/conversations/old")).body.status).toBe("finished");
    expect(filesOn("agent/old")).toHaveLength(3);
    expect(git(origin, "log", "--format=%s", "agent/old").trim().split("\n")).toEqual(["First", "First", "init"]);

    // A branch that was never pushed cannot come back: the conversation starts again from the base.
    await call("PUT", "/conversations/lost", { prompt: "fail" });
    await runner.idle();
    git(checkout, "checkout", "--quiet", "main");
    git(checkout, "branch", "-D", "agent/lost");
    await call("POST", "/conversations/lost/runs", { prompt: "Retry" });
    await runner.idle();
    expect((await call("GET", "/conversations/lost")).body).toMatchObject({ status: "finished", branch: "agent/lost" });
    expect(filesOn("agent/lost")).toHaveLength(2);
  });

  it("reports failures and does not publish them", async () => {
    await call("PUT", "/conversations/broken", { prompt: "fail", repository: REPOSITORY, openPr: true });
    await runner.idle();
    const result = await call("GET", "/conversations/broken");
    expect(result.body.status).toBe("failed");
    // Rakazo shows only `summary`, so a failed run says there why it failed.
    expect(result.body.error).toBe("Claude Code failed: error_during_execution");
    expect(result.body.summary).toBe(result.body.error);
    expect(result.body.branch).toBeUndefined();
    expect(result.body.prUrl).toBeUndefined();
  });

  it("cuts the summary to what Rakazo keeps of a reply", async () => {
    const line = "x".repeat(25_000);
    await call("PUT", "/conversations/long", { prompt: `${line}\nmore` });
    await runner.idle();
    const { title, summary } = (await call("GET", "/conversations/long")).body;
    expect(title).toHaveLength(80);
    expect(summary).toHaveLength(20_000);
    expect(summary!.startsWith("Done: xxx")).toBe(true);
    expect(summary!.endsWith("…")).toBe(true);
    // The whole answer is in the database.
    expect(await sql("SELECT length(result_text) AS n FROM runs WHERE conversation_id = 'long'")).toEqual([{ n: 25_006 }]);
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
      root,
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

    // The launch's `repository` names the checkout, and is the conversation's.
    expect(await sql("SELECT id, title, repository, branch, session_started, pushed, pr_url, base_commit IS NOT NULL AS has_base FROM conversations")).toEqual([
      { id: "kept", title: "Add a file", repository: REPOSITORY, branch: "agent/kept", session_started: true, pushed: true, pr_url: `${REPOSITORY}/pull/7`, has_base: true },
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

  it("streams a running run's events to the conversation page", async () => {
    const launched = await call("PUT", "/conversations/live", { prompt: "stream please" });
    const runId = launched.body.runId!;

    // A page that shows no running run is told to reload; so is one with a stale run.
    const idle = await openStream("/ui/conversations/live/stream");
    expect(idle.response.headers.get("content-type")).toContain("text/event-stream");
    expect((await idle.next())?.event).toBe("ready");
    expect((await idle.next())?.event).toBe("reload");
    expect(await idle.next()).toBeUndefined();
    const stale = await openStream("/ui/agents/live/stream?run=old&after=0");
    await stale.until((message) => message.event === "reload");

    // The page carries the run it shows as running and how many events it has.
    const html = await (await fetch(`${base}/ui/conversations/live`)).text();
    expect(html).toContain(`data-run="${runId}"`);
    expect(html).toContain(`id="events-${runId}"`);

    const live = await openStream(`/ui/conversations/live/stream?run=${runId}&after=0`);
    const ops = [];
    for (;;) {
      const message = await live.until((item) => item.event === "patch");
      ops.push(...message.data.ops!);
      if (ops.some((op) => op.op === "append" && op.html.includes('id="tool-toolu_1"'))) break;
    }
    expect(ops.find((op) => op.op === "append" && op.html.includes("Looking"))).toMatchObject({
      target: `events-${runId}`,
      html: expect.stringContaining("<strong>around</strong>"),
    });
    expect(ops.findLast((op) => op.id === "activity")?.html).toContain("Running Run the tests");

    writeFileSync(path.join(dir, "gate"), "");
    const done = [];
    for (;;) {
      const message = await live.next();
      if (!message || message.event === "reload") break;
      if (message.event === "patch") done.push(...message.data.ops!);
    }
    expect(done.find((op) => op.op === "replace" && op.id === "tool-toolu_1")?.html).toContain("all 12 passed");
    expect(done.some((op) => op.op === "append" && op.html.includes("Tests pass."))).toBe(true);
    await runner.idle();

    // Once the run has ended the stream has nothing to replay: the page reloads.
    const after = await openStream(`/ui/conversations/live/stream?run=${runId}&after=2`);
    await after.until((message) => message.event === "reload");
    // A page showing no running run waits, and reloads when a follow-up starts.
    const waiting = await openStream("/ui/conversations/live/stream");
    expect((await waiting.next())?.event).toBe("ready");
    rmSync(path.join(dir, "gate"));
    const followup = await call("POST", "/conversations/live/runs", { prompt: "hang" });
    expect((await waiting.next())?.event).toBe("reload");
    await call("POST", `/conversations/live/runs/${followup.body.runId}/cancel`);

    expect((await fetch(`${base}/ui/conversations/missing/stream`)).status).toBe(404);
  });

  it("steers a running run with messages, stored before they are sent", async () => {
    const launched = await call("PUT", "/conversations/steered", { prompt: "merge please" });
    const runId = launched.body.runId!;
    const live = await openStream(`/ui/conversations/steered/stream?run=${runId}&after=0&messages=0`);
    await live.until((message) => message.event === "patch" && message.data.ops!.some((op) => op.html.includes("Working on it")));
    const sent = await call("POST", `/conversations/steered/runs/${runId}/messages`, { prompt: "Use pnpm, not npm" });
    expect(sent).toMatchObject({ status: 200, body: { status: "running", runId } });

    // The page shows the message as soon as it is sent.
    const patch = await live.until((message) => message.event === "patch" && message.data.ops!.some((op) => op.html.includes("user-msg steer")));
    expect(patch.data.messages).toBe(1);
    expect(patch.data.ops!.find((op) => op.html.includes("user-msg steer"))?.html).toContain("Use pnpm, not npm");

    // Claude took it into the turn it was on; with no second result, stdin closes once it is quiet.
    await runner.idle();
    expect((await call("GET", "/conversations/steered")).body.status).toBe("finished");
    expect(await sql("SELECT seq, prompt FROM run_messages WHERE run_id = $1", [runId])).toEqual([
      { seq: 1, prompt: "Use pnpm, not npm" },
    ]);
    const texts = await sql("SELECT content->0->>'text' AS text FROM events WHERE run_id = $1 AND type = 'assistant' ORDER BY seq", [runId]);
    expect(texts.map((row) => row.text)).toEqual(["Working on it", "Steered: Use pnpm, not npm"]);

    // Kept across a restart, and shown in the transcript between the events around it.
    await restart();
    const html = await (await fetch(`${base}/ui/conversations/steered`)).text();
    expect(html.indexOf("Working on it")).toBeLessThan(html.indexOf("Use pnpm, not npm"));
    expect(html.indexOf("Use pnpm, not npm")).toBeLessThan(html.indexOf("Steered: Use pnpm"));
    expect(html).toContain("Sent while Claude was working");
    // The page's scripts are built in template strings, where a lost backslash breaks them.
    const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((match) => match[1]!);
    expect(scripts.length).toBeGreaterThan(0);
    for (const source of scripts) expect(() => new Function(source)).not.toThrow();

    // Only a running run takes messages.
    expect(await call("POST", `/conversations/steered/runs/${runId}/messages`, { prompt: "late" })).toEqual({
      status: 409,
      body: { code: "not_running" },
    });
    expect((await call("POST", "/conversations/steered/runs/nope/messages", { prompt: "x" })).status).toBe(404);
    expect((await call("POST", `/agents/steered/runs/${runId}/messages`, { prompt: " " })).status).toBe(400);
  });

  it("keeps stdin open until Claude has answered every message", async () => {
    const launched = await call("PUT", "/conversations/turns", { prompt: "turns" });
    const runId = launched.body.runId!;
    for (const prompt of ["second", "third"])
      expect((await call("POST", `/conversations/turns/runs/${runId}/messages`, { prompt })).status).toBe(200);
    writeFileSync(path.join(dir, "gate"), "");
    await runner.idle();
    expect((await call("GET", "/conversations/turns")).body.status).toBe("finished");
    const texts = await sql("SELECT content->0->>'text' AS text FROM events WHERE run_id = $1 AND type = 'assistant' ORDER BY seq", [runId]);
    expect(texts.map((row) => row.text)).toEqual(["Echo: first", "Echo: second", "Echo: third"]);
    expect(await sql("SELECT count(*)::int AS n FROM events WHERE run_id = $1 AND type = 'result'", [runId])).toEqual([{ n: 3 }]);
  });

  it("refuses messages to a cancelled run", async () => {
    const launched = await call("PUT", "/conversations/stopped", { prompt: "hang" });
    await call("POST", `/conversations/stopped/runs/${launched.body.runId}/cancel`);
    expect((await call("POST", `/conversations/stopped/runs/${launched.body.runId}/messages`, { prompt: "x" })).body).toEqual({
      code: "not_running",
    });
  });

  it("validates requests and reports unknown conversations", async () => {
    expect((await call("PUT", "/conversations/bad", { prompt: "" })).status).toBe(400);
    expect(
      (await call("PUT", "/conversations/bad", { prompt: "x", repository: "file:///etc" })).status,
    ).toBe(400);
    // A repository URL has to name a directory under the root.
    expect((await call("PUT", "/conversations/bad", { prompt: "x", repository: "https://github.com/" })).status).toBe(400);
    expect((await call("PUT", "/conversations/bad", { prompt: "x", repository: "https://github.com/a/.." })).status).toBe(400);
    expect((await call("GET", "/conversations/missing")).body).toEqual({ code: "not_found" });
    expect((await call("GET", "/conversations/bad%2F..")).status).toBe(404);
  });
});
