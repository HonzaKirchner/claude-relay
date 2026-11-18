import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import type { Server } from "node:http";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHandler } from "./http.ts";
import type { ConversationView, Transcript } from "./runner.ts";
import { ConversationRunner, NO_REPOSITORY } from "./runner.ts";
import { SecretStore } from "./secrets.ts";
import { Store } from "./store.ts";

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
/** Where the service keeps what it remembers, and the secrets it is handed. */
let state: string;
let secretsDir: string;
/** Stands in for the service's own environment, which the secrets go into. */
let secretEnv: NodeJS.ProcessEnv;
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
  baseBranch?: string;
  claudeModel?: string;
  root?: string;
}

async function start(options: StartOptions = {}) {
  store = new Store(state);
  await store.prepare();
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
  secretEnv = {};
  const secrets = new SecretStore(secretsDir, secretEnv);
  await secrets.load();
  server = createServer(createHandler(runner, secrets));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

/** Like a service restart: everything the new runner knows comes from its files. */
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
}

/** What the service keeps of a conversation, read straight from its file. */
function kept(id: string) {
  return JSON.parse(readFileSync(path.join(state, "conversations", `${id}.json`), "utf8"));
}

/** The events the service keeps of a run, read straight from its file. */
function eventsOf(runId: string): Array<{ at: string; event: Record<string, any> }> {
  return readFileSync(path.join(state, "events", `${runId}.jsonl`), "utf8").trim().split("\n").map((line) => JSON.parse(line));
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

/** Waits until `claude` has been started `count` times: the checkouts are then prepared. */
async function claudeStarted(count: number) {
  for (;;) {
    let started = 0;
    try {
      started = claudeCalls().length;
    } catch {
      // No call yet.
    }
    if (started >= count) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

/** A launch (PUT) names `REPOSITORY` unless the body says otherwise (`repository: undefined` names none). */
async function call(method: string, pathname: string, body?: unknown) {
  const sent = method === "PUT" && body !== undefined ? { repository: REPOSITORY, ...(body as object) } : body;
  const response = await fetch(`${base}${pathname}`, {
    method,
    headers: { "content-type": "application/json" },
    body: sent === undefined ? undefined : JSON.stringify(sent),
  });
  const json = (await response.json()) as Partial<ConversationView> & { code?: string; detail?: string };
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
  state = path.join(dir, "state");
  secretsDir = path.join(dir, "secrets");
  await start();
});

afterEach(async () => {
  await stop();
  rmSync(dir, { recursive: true, force: true });
});

describe("claude code runner", () => {
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

  it("runs one conversation at a time across the root and cancels a run", async () => {
    const launched = await call("PUT", "/conversations/busy", { prompt: "hang" });
    // The checkouts together are one platform: while a run is going, nothing else starts anywhere.
    expect(await call("POST", "/conversations/busy/runs", { prompt: "More" })).toEqual({
      status: 409,
      body: { code: "busy", reason: "locked", conversation: "busy" },
    });
    expect(await call("PUT", "/conversations/other", { prompt: "hi" })).toEqual({
      status: 409,
      body: { code: "busy", reason: "locked", conversation: "busy" },
    });
    expect(await call("PUT", "/conversations/elsewhere", { prompt: "hi", repository: OTHER })).toEqual({
      status: 409,
      body: { code: "busy", reason: "locked", conversation: "busy" },
    });
    expect((await call("GET", "/conversations/other")).status).toBe(404);
    expect((await call("GET", "/conversations/elsewhere")).status).toBe(404);
    const cancelled = await call("POST", `/conversations/busy/runs/${launched.body.runId}/cancel`);
    expect(cancelled.body.status).toBe("cancelled");
    expect(
      (await call("POST", `/conversations/busy/runs/${launched.body.runId}/cancel`)).body.status,
    ).toBe("cancelled");
    // Once it has stopped, the root is free for anyone.
    expect((await call("PUT", "/conversations/other", { prompt: "hi" })).status).toBe(200);
    await runner.idle();
    expect((await call("GET", "/conversations/other")).body.status).toBe("finished");
    expect((await call("POST", "/conversations/busy/runs", { prompt: "Again" })).status).toBe(200);
    await runner.idle();
    expect((await call("GET", "/conversations/busy")).body.status).toBe("finished");
  });

  it("works in the checkout of the launch's repository and puts the other checkouts on their default branch", async () => {
    const demoRun = await call("PUT", "/conversations/demo-1", { prompt: "hang" });
    // Another repository's checkout is free, but the platform is not: refused with the conversation running.
    expect(await call("PUT", "/conversations/other-1", { prompt: "hang", repository: OTHER })).toEqual({
      status: 409,
      body: { code: "busy", reason: "locked", conversation: "demo-1" },
    });
    expect((await call("POST", "/conversations/demo-1/runs", { prompt: "more" })).body).toMatchObject({ conversation: "demo-1" });
    await claudeStarted(1);
    await call("POST", `/conversations/demo-1/runs/${demoRun.body.runId}/cancel`);
    expect(git(checkout, "rev-parse", "--abbrev-ref", "HEAD").trim()).toBe("agent/demo-1");

    // `.git` and case are not a different repository.
    await call("PUT", "/conversations/other-2", { prompt: "Add a file", repository: "https://github.com/Example/other.git", openPr: true });
    expect(await finished("other-2")).toMatchObject({
      status: "finished",
      branch: "agent/other-2",
      prUrl: `${OTHER}/pull/7`,
    });
    expect(filesOn("agent/other-2", otherOrigin)).toEqual(["README.md", expect.stringMatching(/^change-/)]);
    expect(git(other, "rev-parse", "--abbrev-ref", "HEAD").trim()).toBe("agent/other-2");
    expect(kept("other-2").repository).toBe("https://github.com/Example/other");
    // The run put demo's checkout back on its default branch: the platform is other-2's work on top of the defaults.
    expect(git(checkout, "rev-parse", "--abbrev-ref", "HEAD").trim()).toBe("main");
    expect(() => git(origin, "rev-parse", "--verify", "agent/other-2")).toThrow();

    // The default branch is brought up to the origin where that is a fast-forward.
    const seed = path.join(dir, "demo-seed");
    git(seed, "checkout", "--quiet", "main");
    writeFileSync(path.join(seed, "NEWS.md"), "news\n");
    git(seed, "add", ".");
    git(seed, "commit", "-m", "news");
    git(seed, "push", origin, "main");
    await call("POST", "/conversations/other-2/runs", { prompt: "Again" });
    await runner.idle();
    expect(git(checkout, "log", "--format=%s", "-1").trim()).toBe("news");
    // A diverged default branch (a person's own commits) is left as it is, with a warning.
    git(other, "checkout", "--quiet", "main");
    writeFileSync(path.join(other, "LOCAL.md"), "local\n");
    git(other, "add", ".");
    git(other, "commit", "-m", "local");
    await call("POST", "/conversations/demo-1/runs", { prompt: "Back" });
    await runner.idle();
    expect((await call("GET", "/conversations/demo-1")).body.status).toBe("finished");
    expect(git(other, "log", "--format=%s", "-1").trim()).toBe("local");
    expect(git(checkout, "rev-parse", "--abbrev-ref", "HEAD").trim()).toBe("agent/demo-1");
  }, 20_000); // Five runs and a few dozen git commands: about 6 s on a laptop.

  it("runs a launch that names no repository in the root, on no branch, publishing nothing", async () => {
    // A conversation in a checkout leaves it on its branch: the picture a task without one keeps.
    await call("PUT", "/conversations/before", { prompt: "First" });
    await runner.idle();
    const pushed = git(origin, "for-each-ref", "--format=%(refname)");

    const launched = await call("PUT", "/conversations/none", { prompt: "How are you?", repository: NO_REPOSITORY });
    expect(launched).toMatchObject({ status: 200, body: { status: "running" } });
    await runner.idle();
    const view = (await call("GET", "/conversations/none")).body;
    expect(view).toMatchObject({ status: "finished", summary: "Done: How are you?" });
    expect(view).not.toHaveProperty("branch");
    expect(view).not.toHaveProperty("prUrl");

    // Claude ran in the root itself, and was told the task has no repository.
    expect(readdirSync(root).some((name) => name.startsWith("change-"))).toBe(true);
    const note = claudeCalls().at(-1)!;
    expect(note[note.indexOf("--append-system-prompt") + 1]).toContain("names no repository");
    // No checkout was switched, and nothing was committed or pushed.
    expect(git(checkout, "rev-parse", "--abbrev-ref", "HEAD").trim()).toBe("agent/before");
    expect(git(other, "rev-parse", "--abbrev-ref", "HEAD").trim()).toBe("main");
    expect(git(checkout, "status", "--porcelain")).toBe("");
    expect(git(origin, "for-each-ref", "--format=%(refname)")).toBe(pushed);

    // It is listed and read without a repository or a branch, and can be followed up.
    const transcript = (await call("GET", "/conversations/none/transcript")).body as unknown as Transcript;
    expect(transcript).toMatchObject({ pushed: false, composer: { mode: "reply" } });
    expect(transcript).not.toHaveProperty("repository");
    expect(transcript).not.toHaveProperty("branch");
    expect((await call("GET", "/availability?conversation=none")).body).toEqual({ available: true });
    expect((await call("POST", "/conversations/none/runs", { prompt: "And now?" })).status).toBe(200);
    await runner.idle();
    expect((await call("GET", "/conversations/none")).body).toMatchObject({ status: "finished", summary: "Done: And now?" });
    expect(claudeCalls().at(-1)).toContain("--resume");

    // It survives a restart as what it is.
    await restart();
    expect(((await call("GET", "/conversations/none/transcript")).body as unknown as Transcript).composer).toEqual({ mode: "reply" });

    // The one run at a time, and a dirty checkout, hold for it as for any other.
    writeFileSync(path.join(other, "notes.txt"), "by hand\n");
    expect(await call("PUT", "/conversations/blocked", { prompt: "hi", repository: NO_REPOSITORY })).toEqual({
      status: 409,
      body: { code: "busy", reason: "dirty", branch: "main", path: other },
    });
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
    for (const id of ["bare", "named"]) expect(kept(id)).toMatchObject({ id, repository: REPOSITORY, pushed: true });
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

    // Another conversation would start on those changes: refused, and not created. So is one
    // in another repository: the checkouts together are one platform.
    expect(await call("PUT", "/conversations/next", { prompt: "hi" })).toEqual({
      status: 409,
      body: { code: "busy", reason: "dirty", branch: "agent/messy", path: checkout },
    });
    expect(await call("PUT", "/conversations/elsewhere", { prompt: "hi", repository: OTHER })).toEqual({
      status: 409,
      body: { code: "busy", reason: "dirty", branch: "agent/messy", path: checkout },
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

    // A person's own changes in a checkout are refused as well, whatever branch they are on,
    // even for a conversation working elsewhere.
    git(checkout, "checkout", "--quiet", "main");
    writeFileSync(path.join(checkout, "README.md"), "edited by hand\n");
    expect(await call("POST", "/conversations/next/runs", { prompt: "more" })).toEqual({
      status: 409,
      body: { code: "busy", reason: "dirty", branch: "main", path: checkout },
    });
    git(checkout, "checkout", "--quiet", "README.md");
    writeFileSync(path.join(other, "notes.txt"), "by hand\n");
    expect(await call("POST", "/conversations/next/runs", { prompt: "more" })).toEqual({
      status: 409,
      body: { code: "busy", reason: "dirty", branch: "main", path: other },
    });
    expect((await call("GET", "/conversations/next")).body.status).toBe("finished");
  });

  it("describes the workspace: the run going and each checkout's branch", async () => {
    // The service's own checkout is not part of the platform, even when it lives under the root,
    // and neither is the dev sandbox's own repository.
    symlinkSync(process.cwd(), path.join(root, "claude-relay"));
    git(root, "clone", "--quiet", otherOrigin, "apify-dev-sandbox");
    const idle = await (await fetch(`${base}/workspace`)).json();
    expect(idle).toEqual({
      checkouts: [
        { name: "demo", path: checkout, repository: REPOSITORY, branch: "main", defaultBranch: "main", dirty: false },
        { name: "other", path: other, repository: OTHER, branch: "main", defaultBranch: "main", dirty: false },
      ],
    });
    const launched = await call("PUT", "/conversations/busy", { prompt: "hang\nmore" });
    await claudeStarted(1);
    expect(await (await fetch(`${base}/workspace`)).json()).toEqual({
      running: { conversation: "busy", title: "hang", runId: launched.body.runId, startedAt: expect.any(String), checkout },
      checkouts: [
        { name: "demo", path: checkout, repository: REPOSITORY, branch: "agent/busy", defaultBranch: "main", dirty: false, conversation: "busy" },
        { name: "other", path: other, repository: OTHER, branch: "main", defaultBranch: "main", dirty: false },
      ],
    });
    await call("POST", `/conversations/busy/runs/${launched.body.runId}/cancel`);
    // The root itself when it is the checkout.
    await restart({ root: checkout });
    expect(await (await fetch(`${base}/workspace`)).json()).toEqual({
      checkouts: [{ name: "demo", path: checkout, repository: REPOSITORY, branch: "agent/busy", defaultBranch: "main", dirty: false, conversation: "busy" }],
    });
  });

  it("lists the conversations, most recently active first", async () => {
    expect(await call("GET", "/conversations")).toEqual({ status: 200, body: { conversations: [] } });
    await call("PUT", "/conversations/first", { prompt: "one\nmore" });
    await finished("first");
    await call("PUT", "/conversations/second", { prompt: "two" });
    await finished("second");
    const summary = (id: string, title: string) => ({ id, title, status: "finished", runCount: 1, repository: REPOSITORY, branch: `agent/${id}`, updatedAt: expect.any(String) });
    const listed = await call("GET", "/conversations");
    expect(listed).toEqual({ status: 200, body: { conversations: [summary("second", "two"), summary("first", "one")] } });
    expect(await call("GET", "/agents")).toEqual(listed);
  });

  it("gives a conversation's transcript: every run with its events, and what the message box can do", async () => {
    expect(await call("GET", "/conversations/none/transcript")).toEqual({ status: 404, body: { code: "not_found" } });
    await call("PUT", "/conversations/first", { prompt: "one\nmore" });
    await finished("first");
    const { status, body: view } = await call("GET", "/conversations/first/transcript");
    const body = view as unknown as Transcript;
    expect(status).toBe(200);
    expect(body).toMatchObject({
      id: "first",
      title: "one",
      repository: REPOSITORY,
      branch: "agent/first",
      runs: [{ seq: 1, status: "finished", prompt: "one\nmore", startedAt: expect.any(String), firstEvent: 0 }],
      composer: { mode: "reply" },
    });
    expect(body.runs[0]!.events.length).toBeGreaterThan(0);
    expect(body.runs[0]!.events[0]).toEqual({ at: expect.any(String), event: expect.any(Object) });
    expect(await call("GET", "/agents/first/transcript")).toEqual({ status, body: view });
  });

  it("says whether a run could start, without starting one", async () => {
    const availability = async (query = "") => (await call("GET", `/availability${query}`)).body;
    // Idle, with every checkout clean: any run could start.
    expect(await availability()).toEqual({ available: true });

    // While a run is going, nothing could start anywhere, not even a follow-up of its own conversation.
    const launched = await call("PUT", "/conversations/busy", { prompt: "hang\nmore" });
    await claudeStarted(1);
    const locked = { available: false, reason: "locked", conversation: "busy", title: "hang" };
    expect(await availability()).toEqual(locked);
    expect(await availability("?conversation=busy")).toEqual(locked);
    await call("POST", `/conversations/busy/runs/${launched.body.runId}/cancel`);
    expect(await availability()).toEqual({ available: true });

    // Leftovers of a failed run block everything but that conversation's own follow-up.
    await call("PUT", "/conversations/messy", { prompt: "dirty" });
    await runner.idle();
    const dirty = { available: false, reason: "dirty", name: "demo", path: checkout, branch: "agent/messy" };
    expect(await availability()).toEqual(dirty);
    expect(await availability("?conversation=busy")).toEqual(dirty);
    expect(await availability("?conversation=messy")).toEqual({ available: true });
    // The check itself changed nothing: no run was started, and the checkout is as it was.
    expect(claudeCalls()).toHaveLength(2);
    expect(git(checkout, "status", "--porcelain")).toContain("leftover.txt");

    expect(await call("GET", "/availability?conversation=unknown")).toEqual({ status: 404, body: { code: "not_found" } });
    expect((await call("GET", "/availability?conversation=bad%2Fid")).status).toBe(400);
  }, 20_000); // Two runs and a fresh scan per check: about 6 s on a laptop.

  it("says what a conversation's message box can do: steer, follow up, or neither with the reason", async () => {
    const composer = async (id: string) => ((await call("GET", `/conversations/${id}/transcript`)).body as unknown as Transcript).composer;
    await call("PUT", "/conversations/second", { prompt: "hi", repository: OTHER });
    await runner.idle();
    const launched = await call("PUT", "/conversations/first", { prompt: "hang" });
    // The running conversation is steered; another one waits for it.
    expect(await composer("first")).toEqual({ mode: "steer", runId: launched.body.runId });
    expect(await composer("second")).toEqual({ mode: "off", reason: "locked", conversation: "first", title: "hang" });
    await call("POST", `/conversations/first/runs/${launched.body.runId}/cancel`);
    // The runner is idle: both can go on.
    for (const id of ["first", "second"]) expect(await composer(id)).toEqual({ mode: "reply" });

    // A checkout with leftovers: its own conversation goes on, every other is told what to clean up.
    await call("POST", "/conversations/first/runs", { prompt: "dirty" });
    await runner.idle();
    expect(await composer("first")).toEqual({ mode: "reply" });
    expect(await composer("second")).toEqual({ mode: "off", reason: "dirty", name: "demo", path: checkout, branch: "agent/first" });
  });

  it("starts a conversation from the named base branch", async () => {
    expect((await call("PUT", "/conversations/bad", { prompt: "x", baseBranch: "-x" })).status).toBe(400);
    expect((await call("PUT", "/conversations/bad", { prompt: "x", baseBranch: "a b" })).status).toBe(400);
    await call("PUT", "/conversations/rel", { prompt: "On release", baseBranch: "release" });
    await runner.idle();
    expect(filesOn("agent/rel")).toEqual(["README.md", "RELEASE.md", expect.stringMatching(/^change-/)]);
    expect(kept("rel").baseBranch).toBe("release");

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
    // The whole answer is in the run's events.
    expect(eventsOf(kept("long").runs[0].id).at(-1)!.event.result).toHaveLength(25_006);
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
    await store.flush();
    writeFileSync(path.join(state, "conversations", "stuck.json"), JSON.stringify({ ...kept("stuck"), sessionStarted: true }));
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
    await store.flush();
    const otherStore = new Store(state);
    const restarted = new ConversationRunner({
      store: otherStore,
      root,
      claudeCommand: "claude",
      ghCommand: "gh",
    });
    await restarted.load();
    expect(restarted.get("restart")?.status).toBe("failed");
    const run = runner.get("restart")!.runId;
    await call("POST", `/conversations/restart/runs/${run}/cancel`);
  });

  it("keeps what it remembers in files only it can read, and knows everything from them after a restart", async () => {
    const launched = await call("PUT", "/conversations/kept", {
      prompt: "Add a file",
      repository: REPOSITORY,
      openPr: true,
    });
    await runner.idle();
    await call("POST", "/conversations/kept/runs", { prompt: "refuse" });
    await runner.idle();

    // The launch's `repository` names the checkout, and is the conversation's.
    const file = path.join(state, "conversations", "kept.json");
    const kept = JSON.parse(readFileSync(file, "utf8"));
    expect(kept).toMatchObject({
      id: "kept",
      title: "Add a file",
      repository: REPOSITORY,
      branch: "agent/kept",
      sessionStarted: true,
      pushed: true,
      prUrl: `${REPOSITORY}/pull/7`,
      baseCommit: expect.any(String),
      runs: [
        { status: "finished", prompt: "Add a file" },
        { status: "failed", prompt: "refuse", error: expect.stringContaining("root/sudo"), stderr: expect.stringContaining("--dangerously-skip-permissions cannot be used") },
      ],
    });
    const events = readFileSync(path.join(state, "events", `${launched.body.runId}.jsonl`), "utf8").trim().split("\n").map((line) => JSON.parse(line));
    expect(events.map(({ event }) => [event.type, event.subtype])).toEqual([["system", "init"], ["result", "success"]]);
    expect(events[0].at).toEqual(expect.any(String));
    expect(statSync(file).mode & 0o077).toBe(0);
    expect(readdirSync(path.join(state, "events"))).toHaveLength(1);

    await restart();
    expect((await call("GET", `/conversations/kept/runs/${launched.body.runId}`)).body).toMatchObject({
      status: "finished",
      branch: "agent/kept",
      prUrl: `${REPOSITORY}/pull/7`,
    });
    expect((await call("GET", "/conversations/kept")).body.status).toBe("failed");
    const transcript = (await call("GET", "/conversations/kept/transcript")).body as unknown as Transcript;
    expect(transcript.runs.map((run) => [run.seq, run.events.length])).toEqual([[1, 2], [2, 0]]);
  });

  it("starts nothing when the launch cannot be stored", async () => {
    // The directory conversations are written to is gone, and a file sits where it was.
    rmSync(path.join(state, "conversations"), { recursive: true });
    writeFileSync(path.join(state, "conversations"), "");
    expect(await call("PUT", "/conversations/lost", { prompt: "hi" })).toEqual({
      status: 500,
      body: { code: "internal" },
    });
    expect((await call("GET", "/conversations/lost")).status).toBe(404);
    expect(() => claudeCalls()).toThrow();
  });

  it("gives a caller that says what it has only the events it lacks", async () => {
    const launched = await call("PUT", "/conversations/live", { prompt: "stream please" });
    const runId = launched.body.runId!;
    const fetched = async (query = "") => ((await call("GET", `/conversations/live/transcript${query}`)).body as unknown as Transcript).runs[0]!;
    const texts = (run: Transcript["runs"][number]) => run.events.map(({ event }) => event.type);
    // While the run goes: what Claude has printed so far.
    let run = await fetched();
    while (run.events.length < 2) {
      await new Promise((resolve) => setTimeout(resolve, 25));
      run = await fetched();
    }
    expect(run).toMatchObject({ id: runId, status: "running", firstEvent: 0 });
    expect(texts(run)).toEqual(["system", "assistant"]);

    writeFileSync(path.join(dir, "gate"), "");
    await runner.idle();
    // Holding those two, the caller gets the three that followed, and nothing when it holds all five.
    run = await fetched(`?have=${runId}:2`);
    expect(run).toMatchObject({ status: "finished", firstEvent: 2 });
    expect(texts(run)).toEqual(["user", "assistant", "result"]);
    expect(await fetched(`?have=${runId}:5,other-run:9`)).toMatchObject({ firstEvent: 5, events: [] });
    // More than there are is taken for all of them; a malformed list is refused.
    expect(await fetched(`?have=${runId}:99`)).toMatchObject({ firstEvent: 5, events: [] });
    expect((await call("GET", "/conversations/live/transcript?have=nonsense")).status).toBe(400);
  });

  it("steers a running run with messages, stored before they are sent", async () => {
    const launched = await call("PUT", "/conversations/steered", { prompt: "merge please" });
    const runId = launched.body.runId!;
    const transcript = async () => ((await call("GET", "/conversations/steered/transcript")).body as unknown as Transcript).runs[0]!;
    while ((await transcript()).events.length < 2) await new Promise((resolve) => setTimeout(resolve, 25));
    const sent = await call("POST", `/conversations/steered/runs/${runId}/messages`, { prompt: "Use pnpm, not npm" });
    expect(sent).toMatchObject({ status: 200, body: { status: "running", runId } });

    // Stored as soon as it is sent.
    expect((await transcript()).messages).toMatchObject([{ prompt: "Use pnpm, not npm", sentAt: expect.any(String) }]);

    // Claude took it into the turn it was on; with no second result, stdin closes once it is quiet.
    await runner.idle();
    expect((await call("GET", "/conversations/steered")).body.status).toBe("finished");
    const texts = (run: Transcript["runs"][number]) =>
      run.events.flatMap(({ event }) => (event.type === "assistant" ? [(event as { message: { content: Array<{ text: string }> } }).message.content[0]!.text] : []));
    expect(texts(await transcript())).toEqual(["Working on it", "Steered: Use pnpm, not npm"]);

    // Kept across a restart, with when it was sent: between the events around it.
    await restart();
    const run = await transcript();
    expect(run.messages).toMatchObject([{ prompt: "Use pnpm, not npm" }]);
    const sentAt = run.messages![0]!.sentAt;
    const answers = run.events.filter(({ event }) => event.type === "assistant");
    expect(answers[0]!.at <= sentAt && sentAt <= answers[1]!.at).toBe(true);

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
    const events = eventsOf(runId).map(({ event }) => event);
    expect(events.filter((event) => event.type === "assistant").map((event) => event.message.content[0].text)).toEqual(["Echo: first", "Echo: second", "Echo: third"]);
    expect(events.filter((event) => event.type === "result")).toHaveLength(3);
  });

  it("refuses messages to a cancelled run", async () => {
    const launched = await call("PUT", "/conversations/stopped", { prompt: "hang" });
    await call("POST", `/conversations/stopped/runs/${launched.body.runId}/cancel`);
    expect((await call("POST", `/conversations/stopped/runs/${launched.body.runId}/messages`, { prompt: "x" })).body).toEqual({
      code: "not_running",
    });
  });

  it("validates requests and reports unknown conversations", async () => {
    // A rejected request says what is wrong with it (`detail`), since Rakazo shows nothing of it.
    const rejected = async (body: unknown) => {
      const response = await call("PUT", "/conversations/bad", body);
      expect(response.status).toBe(400);
      expect(response.body.code).toBe("invalid");
      return response.body.detail;
    };
    expect(await rejected({ prompt: "" })).toBe("prompt is blank");
    expect(await rejected({})).toBe("prompt is missing, not a string");
    expect(await rejected({ prompt: 7 })).toBe("prompt is number 7, not a string");
    expect(await rejected({ prompt: "x", repository: "file:///etc" })).toBe('repository "file:///etc" is not an https URL');
    expect(await rejected({ prompt: "x", repository: "not a url" })).toBe('repository "not a url" is not a URL');
    // A repository URL has to name a directory under the root.
    expect(await rejected({ prompt: "x", repository: "https://github.com/" })).toBe('repository "https://github.com/" does not end in a repository name');
    expect(await rejected({ prompt: "x", repository: "https://github.com/a/.." })).toBe('repository "https://github.com/a/.." does not end in a repository name');
    expect(await rejected({ prompt: "x", openPr: "yes" })).toBe("openPr is a string, not a boolean");
    expect(await rejected({ prompt: "x", baseBranch: "a b" })).toBe('baseBranch "a b" is not a branch name');
    expect(await rejected({ prompt: "x", images: [{ data: "AA==", mimeType: "image/bmp" }] })).toBe(
      "images[0].mimeType is a string, not one of image/png, image/jpeg, image/gif, image/webp",
    );
    expect(await rejected({ prompt: "x", images: [{}] })).toBe("images[0] has neither url nor data");
    expect((await call("GET", "/conversations/missing")).body).toEqual({ code: "not_found" });
    expect((await call("GET", "/conversations/bad%2F..")).status).toBe(404);
  });

  it("answers internal when a request fails, and stays up", async () => {
    await call("PUT", "/conversations/stable", { prompt: "hi" });
    await finished("stable");
    vi.spyOn(runner, "get").mockImplementationOnce(() => {
      throw new Error("boom");
    });
    expect(await call("GET", "/conversations/stable")).toEqual({ status: 500, body: { code: "internal" } });
    // A reply that cannot be written out is an error too, not a dropped connection.
    vi.spyOn(runner, "workspace").mockResolvedValueOnce({ cost: 1n } as never);
    expect(await call("GET", "/workspace")).toEqual({ status: 500, body: { code: "internal" } });
    vi.restoreAllMocks();
    expect((await call("GET", "/health")).body).toEqual({ ok: true });
    // The pages are gone: a browser asking for one gets JSON like every other caller.
    expect(await call("GET", "/ui/conversations/stable")).toEqual({ status: 404, body: { code: "route_not_found" } });
  });

  it("takes secrets, keeps them in files only it can read, and gives them to the next run", async () => {
    const put = async (body: unknown) => {
      const response = await fetch(`${base}/secrets`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      return { status: response.status, body: await response.json() };
    };
    expect(await put({ claudeToken: " claude-secret\n", githubToken: "gh-secret" })).toEqual({
      status: 200,
      body: { claudeToken: true, githubToken: true, platformToken: false, platformUrl: false },
    });
    // One left out stays as it was.
    const all = { claudeToken: true, githubToken: true, platformToken: true, platformUrl: true };
    expect(await put({ platformToken: "platform-secret", platformUrl: "https://platform.example.com" })).toEqual({ status: 200, body: all });

    const file = (name: string) => path.join(secretsDir, name);
    expect(readFileSync(file("claude-oauth-token"), "utf8")).toBe("claude-secret\n");
    expect(readFileSync(file("github-token"), "utf8")).toBe("gh-secret\n");
    for (const name of ["claude-oauth-token", "github-token", "platform-token", "platform-url"]) expect(statSync(file(name)).mode & 0o077).toBe(0);
    // What a run needs is in the environment it inherits; what only the service needs is not.
    expect(secretEnv).toMatchObject({
      CLAUDE_CODE_OAUTH_TOKEN: "claude-secret",
      GH_TOKEN: "gh-secret",
      GIT_CONFIG_VALUE_1: "!gh auth git-credential",
    });
    expect(JSON.stringify(secretEnv)).not.toContain("platform-secret");

    // Nothing gives them back, and what is not a secret is refused without being quoted.
    expect((await fetch(`${base}/secrets`)).status).toBe(404);
    const refused = await put({ claudeToken: "two\nlines" });
    expect(refused.status).toBe(400);
    expect(JSON.stringify(refused.body)).not.toContain("two");
    expect((await put({ platformUrl: "not a url" })).status).toBe(400);
    expect(secretEnv.CLAUDE_CODE_OAUTH_TOKEN).toBe("claude-secret");

    // A restarted service reads them back from the files.
    await restart();
    expect(secretEnv).toMatchObject({ CLAUDE_CODE_OAUTH_TOKEN: "claude-secret", GH_TOKEN: "gh-secret" });
    expect((await put({})).body).toEqual(all);
  });
});
