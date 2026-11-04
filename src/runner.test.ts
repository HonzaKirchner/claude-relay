import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import type { Server } from "node:http";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createHandler } from "./http.ts";
import type { AgentView } from "./runner.ts";
import { AgentRunner } from "./runner.ts";

const REPOSITORY = "https://github.com/example/demo";

// Stands in for Claude Code: reads one stream-json user message, then behaves as the prompt says.
const FAKE_CLAUDE = `
const fs = require("node:fs");
fs.appendFileSync(process.env.FAKE_CLAUDE_LOG, JSON.stringify(process.argv.slice(2)) + "\\n");
let input = "";
process.stdin.on("data", (chunk) => (input += chunk));
process.stdin.on("end", () => {
  const text = JSON.parse(input.trim()).message.content[0].text;
  if (text.includes("hang")) return setInterval(() => undefined, 1000);
  if (text.includes("fail")) {
    console.log(JSON.stringify({ type: "result", subtype: "error_during_execution", is_error: true }));
    process.exit(1);
  }
  fs.writeFileSync("change-" + Date.now() + ".txt", text);
  console.log(JSON.stringify({ type: "result", subtype: "success", is_error: false }));
});
`;

const FAKE_GH = `
if (process.argv[2] === "pr" && process.argv[3] === "create") console.log("${REPOSITORY}/pull/7");
else process.exit(1);
`;

let dir: string;
let server: Server;
let runner: AgentRunner;
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

async function start() {
  runner = new AgentRunner({
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

async function call(method: string, pathname: string, body?: unknown) {
  const response = await fetch(`${base}${pathname}`, {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = (await response.json()) as Partial<AgentView> & { code?: string };
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
  await start();
});

afterEach(async () => {
  await runner.idle();
  await new Promise((resolve) => server.close(resolve));
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
    const launched = await call("PUT", "/agents/busy", { prompt: "hang" });
    expect((await call("POST", "/agents/busy/runs", { prompt: "More" })).status).toBe(409);
    const cancelled = await call("POST", `/agents/busy/runs/${launched.body.runId}/cancel`);
    expect(cancelled.body.status).toBe("cancelled");
    expect(
      (await call("POST", `/agents/busy/runs/${launched.body.runId}/cancel`)).body.status,
    ).toBe("cancelled");
    expect((await call("POST", "/agents/busy/runs", { prompt: "Again" })).status).toBe(200);
  });

  it("reports failures and does not publish them", async () => {
    await call("PUT", "/agents/broken", { prompt: "fail", repository: REPOSITORY, openPr: true });
    await runner.idle();
    const result = await call("GET", "/agents/broken");
    expect(result.body.status).toBe("failed");
    expect(result.body.branch).toBeUndefined();
    expect(result.body.prUrl).toBeUndefined();
  });

  it("marks a run interrupted by a restart as failed", async () => {
    await call("PUT", "/agents/restart", { prompt: "hang" });
    const restarted = new AgentRunner({
      dataDir: path.join(dir, "data"),
      claudeCommand: "claude",
      ghCommand: "gh",
    });
    await restarted.load();
    expect(restarted.get("restart")?.status).toBe("failed");
    const run = runner.get("restart")!.runId;
    await call("POST", `/agents/restart/runs/${run}/cancel`);
  });

  it("validates requests and reports unknown agents", async () => {
    expect((await call("PUT", "/agents/bad", { prompt: "" })).status).toBe(400);
    expect(
      (await call("PUT", "/agents/bad", { prompt: "x", repository: "file:///etc" })).status,
    ).toBe(400);
    expect((await call("GET", "/agents/missing")).body).toEqual({ code: "not_found" });
    expect((await call("GET", "/agents/bad%2F..")).status).toBe(404);
  });
});
