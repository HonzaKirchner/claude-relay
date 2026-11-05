// Fills the database at DB_CONNECTION_STRING with made-up conversations, so the
// conversation pages and the API have something to show without running Claude.
//
//   npm run db:seed      (loads .env if present)
//
// Covers every finished status, a follow-up, tool calls (some failing), a steering message,
// a pushed branch with a PR, a run whose stderr was kept, and a long engineering run with
// dozens of tool calls. All ids start with `seed-`. Conversations already in the database
// are skipped, so running it again is safe; start from scratch with `npm run db:reset`.
// No run is left `running`: the service would mark it failed on start, as after a restart.

import { randomUUID } from "node:crypto";
import type { ClaudeEvent, Conversation, Run, RunMessage } from "../src/db.ts";
import { Store } from "../src/db.ts";

// Made-up stream-json events, shaped like what `claude --output-format stream-json --verbose` prints.

const MODEL = "claude-opus-5-5";
const VERSION = "2.4.0";

/** One scripted step of a run: an event, `seconds` after the previous one. */
type Step = { seconds: number; event: ClaudeEvent };

function init(session: string): Step {
  return {
    seconds: 1,
    event: {
      type: "system",
      subtype: "init",
      session_id: session,
      model: MODEL,
      claude_code_version: VERSION,
      cwd: "/home/coder/.claude-code-runner/work",
      tools: ["Agent", "Bash", "Edit", "Glob", "Grep", "Read", "TodoWrite", "Write"],
    },
  };
}

function text(session: string, value: string, seconds = 3): Step {
  return { seconds, event: assistant(session, [{ type: "text", text: value }]) };
}

function thinking(session: string, value: string): Step {
  return { seconds: 4, event: assistant(session, [{ type: "thinking", thinking: value, signature: "" }]) };
}

/** A tool_use from Claude and the tool_result that answers it. */
function tool(
  session: string,
  name: string,
  input: Record<string, unknown>,
  output: string,
  { isError = false, seconds = name === "Bash" ? 6 : 1 }: { isError?: boolean; seconds?: number } = {},
): Step[] {
  const id = `toolu_seed_${randomUUID().replaceAll("-", "").slice(0, 20)}`;
  return [
    { seconds: 2, event: assistant(session, [{ type: "tool_use", id, name, input }]) },
    {
      seconds,
      event: {
        type: "user",
        session_id: session,
        uuid: randomUUID(),
        message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: output, is_error: isError }] },
      },
    },
  ];
}

type Todo = { content: string; status: "pending" | "in_progress" | "completed"; activeForm: string };

/** TodoWrite with the given items; the first `done` are completed and the next one in progress. */
function todos(session: string, items: [content: string, activeForm: string][], done: number): Step[] {
  const list: Todo[] = items.map(([content, activeForm], index) => ({
    content,
    activeForm,
    status: index < done ? "completed" : index === done ? "in_progress" : "pending",
  }));
  return tool(session, "TodoWrite", { todos: list }, "Todos have been modified successfully.");
}

/** Claude's final answer: printed as assistant text, then repeated in the `result`. */
function answer(session: string, value: string, turns: number, cost: number): Step[] {
  return [
    text(session, value),
    {
      seconds: 1,
      event: {
        type: "result",
        subtype: "success",
        is_error: false,
        session_id: session,
        result: value,
        num_turns: turns,
        duration_ms: turns * 9000,
        duration_api_ms: turns * 7000,
        total_cost_usd: cost,
        usage: { input_tokens: turns * 1200, output_tokens: turns * 180, cache_read_input_tokens: turns * 9000 },
      },
    },
  ];
}

function assistant(session: string, content: unknown[]): ClaudeEvent {
  return {
    type: "assistant",
    session_id: session,
    uuid: randomUUID(),
    message: {
      id: `msg_seed_${randomUUID().replaceAll("-", "").slice(0, 20)}`,
      role: "assistant",
      model: MODEL,
      content,
      stop_reason: content.some((block) => (block as { type: string }).type === "tool_use") ? "tool_use" : "end_turn",
      usage: { input_tokens: 1200, output_tokens: 180, cache_read_input_tokens: 9000 },
    },
  };
}

const LONG_TASK_PROMPT = `Rate limits are enforced per replica, so with 4 replicas a client gets 4× the limit. Move the rate limiter to Redis so the limit holds across replicas.

- Keep the in-memory limiter for local development and tests.
- Same response headers as today (X-RateLimit-*, Retry-After).
- No extra round trips per request if you can avoid it.`;

const PLAN: [string, string][] = [
  ["Read the current rate limiter and its config", "Reading the current rate limiter"],
  ["Add a store interface with memory and Redis implementations", "Adding the rate limit stores"],
  ["Switch the middleware to the store and add RATE_LIMIT_STORE", "Wiring the store into the middleware"],
  ["Test both stores, including concurrent requests", "Testing both stores"],
  ["Document the new setting", "Documenting the new setting"],
];

const RATE_LIMIT_TS = `import type { Middleware } from "../http.ts";
import { config } from "../config.ts";

const windows = new Map<string, { start: number; count: number }>();

const rateLimit: Middleware = async (request, next) => {
  const key = request.apiKey ?? request.ip;
  const now = Date.now();
  let window = windows.get(key);
  if (!window || now - window.start >= config.rateLimit.windowMs) {
    window = { start: now, count: 0 };
    windows.set(key, window);
  }
  window.count += 1;
  const remaining = Math.max(0, config.rateLimit.max - window.count);
  const reset = Math.ceil((window.start + config.rateLimit.windowMs) / 1000);
  const headers = {
    "X-RateLimit-Limit": String(config.rateLimit.max),
    "X-RateLimit-Remaining": String(remaining),
    "X-RateLimit-Reset": String(reset),
  };
  if (window.count > config.rateLimit.max) {
    return { status: 429, headers: { ...headers, "Retry-After": String(reset - Math.floor(now / 1000)) } };
  }
  const response = await next(request);
  return { ...response, headers: { ...response.headers, ...headers } };
};`;

const STORE_TS = `/** Counts requests per key in a fixed window. */
export interface RateLimitStore {
  /** Adds one request for \`key\` and returns the count in the current window and when it resets (ms). */
  hit(key: string, windowMs: number): Promise<{ count: number; resetAt: number }>;
}

export class MemoryRateLimitStore implements RateLimitStore {
  private readonly windows = new Map<string, { start: number; count: number }>();

  async hit(key: string, windowMs: number) {
    const now = Date.now();
    let window = this.windows.get(key);
    if (!window || now - window.start >= windowMs) {
      window = { start: now, count: 0 };
      this.windows.set(key, window);
    }
    window.count += 1;
    return { count: window.count, resetAt: window.start + windowMs };
  }
}`;

const REDIS_STORE_TS = `import type { Redis } from "ioredis";
import type { RateLimitStore } from "./rate-limit-store.ts";

// INCR and PEXPIRE in one round trip, atomically: the first hit in a window sets its expiry.
const HIT = \`
local count = redis.call("INCR", KEYS[1])
if count == 1 then redis.call("PEXPIRE", KEYS[1], ARGV[1]) end
return { count, redis.call("PTTL", KEYS[1]) }
\`;

export class RedisRateLimitStore implements RateLimitStore {
  constructor(private readonly redis: Redis, private readonly prefix = "ratelimit:") {
    redis.defineCommand("rateLimitHit", { numberOfKeys: 1, lua: HIT });
  }

  async hit(key: string, windowMs: number) {
    const [count, ttl] = (await (this.redis as any).rateLimitHit(this.prefix + key, windowMs)) as [number, number];
    return { count, resetAt: Date.now() + Math.max(ttl, 0) };
  }
}`;

const TEST_TS = `import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Redis from "ioredis";
import { MemoryRateLimitStore } from "./rate-limit-store.ts";
import { RedisRateLimitStore } from "./redis-rate-limit-store.ts";

const stores = {
  memory: () => new MemoryRateLimitStore(),
  redis: () => new RedisRateLimitStore(new Redis(process.env.REDIS_URL!), \`test:\${Date.now()}:\`),
};

describe.each(Object.entries(stores))("%s store", (_name, create) => {
  beforeEach(() => vi.useFakeTimers({ toFake: ["Date"] }));
  afterEach(() => vi.useRealTimers());

  it("counts hits in a window and starts a new one after it", async () => {
    const store = create();
    expect((await store.hit("a", 1000)).count).toBe(1);
    expect((await store.hit("a", 1000)).count).toBe(2);
    vi.advanceTimersByTime(1000);
    expect((await store.hit("a", 1000)).count).toBe(1);
  });

  it("counts concurrent hits exactly once each", async () => {
    const store = create();
    const counts = await Promise.all(Array.from({ length: 50 }, () => store.hit("b", 60_000)));
    expect(counts.map((hit) => hit.count).sort((x, y) => x - y)).toEqual(Array.from({ length: 50 }, (_, i) => i + 1));
  });
});`;

/** A long engineering run: reading, designing, writing, a failing type check and test, a subagent review. */
function longTask(session: string): Step[] {
  return [
    init(session),
    thinking(
      session,
      "The limiter keeps its windows in a Map inside the process, so every replica counts on its own. " +
        "Redis is already a dependency (the session store uses it), so a shared counter there is the natural fix. " +
        "Fixed window keeps today's semantics and headers; a sliding window would change behaviour clients see. " +
        "INCR + PEXPIRE in a Lua script is one round trip and atomic.",
    ),
    text(
      session,
      "I'll start by reading how the limiter works today and where its settings come from, then split the counting out behind a small store interface so the memory version stays for development and tests.",
    ),
    ...todos(session, PLAN, 0),
    ...tool(session, "Grep", { pattern: "rateLimit", path: "src", output_mode: "files_with_matches" }, "src/app.ts\nsrc/config.ts\nsrc/middleware/rate-limit.ts\nsrc/middleware/rate-limit.test.ts"),
    ...tool(session, "Read", { file_path: "src/middleware/rate-limit.ts" }, RATE_LIMIT_TS),
    ...tool(
      session,
      "Read",
      { file_path: "src/config.ts" },
      "const config = {\n  port: Number(process.env.PORT ?? 3000),\n  redisUrl: process.env.REDIS_URL ?? \"redis://localhost:6379\",\n  rateLimit: {\n    windowMs: Number(process.env.RATE_LIMIT_WINDOW_MS ?? 60_000),\n    max: Number(process.env.RATE_LIMIT_MAX ?? 100),\n  },\n};",
    ),
    text(
      session,
      "This is a **fixed-window** counter kept in a `Map` in each process. That explains the 4× limit: every replica has its own `Map`, and the load balancer spreads a client across all of them. Two smaller issues while I'm here:\n\n" +
        "1. The `Map` never forgets keys, so memory grows with every distinct API key and IP seen since start.\n" +
        "2. `X-RateLimit-Reset` is computed from the window start, which is right, so the Redis version must return when the window ends, not just a count.\n\n" +
        "Redis is already configured (`REDIS_URL`), so let me check how the app connects to it.",
      5,
    ),
    ...tool(session, "Bash", { command: "ls src/lib && grep -n '\"ioredis\"' package.json", description: "List shared libs and check the Redis client" }, "db.ts\nlogger.ts\nredis.ts\nsession.ts\n18:    \"ioredis\": \"^5.4.1\","),
    ...tool(
      session,
      "Read",
      { file_path: "src/lib/redis.ts" },
      "import Redis from \"ioredis\";\nimport { config } from \"../config.ts\";\n\nconst redis = new Redis(config.redisUrl, { maxRetriesPerRequest: 2, enableOfflineQueue: false });",
    ),
    text(
      session,
      "Design:\n\n" +
        "- `RateLimitStore` with one method, `hit(key, windowMs)`, returning the count and when the window resets.\n" +
        "- `MemoryRateLimitStore`: today's logic, moved as is.\n" +
        "- `RedisRateLimitStore`: one Lua script per request doing `INCR`, setting `PEXPIRE` on the first hit, and returning `PTTL`. That's **one round trip**, atomic across replicas, and keys expire on their own, which also fixes the unbounded `Map`.\n" +
        "- `RATE_LIMIT_STORE=memory|redis`, defaulting to `redis` when `NODE_ENV=production`.\n\n" +
        "`enableOfflineQueue: false` means a Redis outage makes `hit` throw. I'll fail **open** there (let the request through and log), since rejecting all traffic because the limiter is down would be worse than briefly not limiting.",
      6,
    ),
    ...todos(session, PLAN, 1),
    ...tool(session, "Write", { file_path: "src/middleware/rate-limit-store.ts", content: STORE_TS }, "File created successfully at: src/middleware/rate-limit-store.ts"),
    ...tool(session, "Write", { file_path: "src/middleware/redis-rate-limit-store.ts", content: REDIS_STORE_TS }, "File created successfully at: src/middleware/redis-rate-limit-store.ts"),
    ...todos(session, PLAN, 2),
    ...tool(
      session,
      "Edit",
      {
        file_path: "src/middleware/rate-limit.ts",
        old_string: "const windows = new Map<string, { start: number; count: number }>();\n\nconst rateLimit: Middleware = async (request, next) => {\n  const key = request.apiKey ?? request.ip;\n  const now = Date.now();\n  let window = windows.get(key);\n  if (!window || now - window.start >= config.rateLimit.windowMs) {\n    window = { start: now, count: 0 };\n    windows.set(key, window);\n  }\n  window.count += 1;\n  const remaining = Math.max(0, config.rateLimit.max - window.count);\n  const reset = Math.ceil((window.start + config.rateLimit.windowMs) / 1000);",
        new_string: "const rateLimit = (store: RateLimitStore): Middleware => async (request, next) => {\n  const key = request.apiKey ?? request.ip;\n  const now = Date.now();\n  let hit;\n  try {\n    hit = await store.hit(key, config.rateLimit.windowMs);\n  } catch (error) {\n    logger.warn(\"rate limit store unavailable, letting the request through\", { error });\n    return next(request);\n  }\n  const remaining = Math.max(0, config.rateLimit.max - hit.count);\n  const reset = Math.ceil(hit.resetAt / 1000);",
      },
      "The file src/middleware/rate-limit.ts has been updated successfully.",
    ),
    ...tool(
      session,
      "Edit",
      { file_path: "src/middleware/rate-limit.ts", old_string: "  if (window.count > config.rateLimit.max) {", new_string: "  if (hit.count > config.rateLimit.max) {" },
      "The file src/middleware/rate-limit.ts has been updated successfully.",
    ),
    ...tool(
      session,
      "Edit",
      {
        file_path: "src/config.ts",
        old_string: "  rateLimit: {\n",
        new_string: "  rateLimit: {\n    store: (process.env.RATE_LIMIT_STORE ?? (process.env.NODE_ENV === \"production\" ? \"redis\" : \"memory\")) as \"memory\" | \"redis\",\n",
      },
      "The file src/config.ts has been updated successfully.",
    ),
    ...tool(
      session,
      "Edit",
      {
        file_path: "src/app.ts",
        old_string: "app.use(rateLimit);",
        new_string: "app.use(rateLimit(config.rateLimit.store === \"redis\" ? new RedisRateLimitStore(redis) : new MemoryRateLimitStore()));",
      },
      "The file src/app.ts has been updated successfully.",
    ),
    ...tool(
      session,
      "Bash",
      { command: "npm run typecheck", description: "Type-check the project" },
      "src/middleware/rate-limit.ts:1:1 - error TS2304: Cannot find name 'RateLimitStore'.\nsrc/middleware/rate-limit.ts:12:5 - error TS2304: Cannot find name 'logger'.\nsrc/app.ts:9:9 - error TS2304: Cannot find name 'RedisRateLimitStore'.\n\nFound 3 errors in 2 files.",
      { isError: true, seconds: 9 },
    ),
    text(session, "Missing imports in both files; adding them."),
    ...tool(
      session,
      "Edit",
      {
        file_path: "src/middleware/rate-limit.ts",
        old_string: "import { config } from \"../config.ts\";",
        new_string: "import { config } from \"../config.ts\";\nimport { logger } from \"../lib/logger.ts\";\nimport type { RateLimitStore } from \"./rate-limit-store.ts\";",
      },
      "The file src/middleware/rate-limit.ts has been updated successfully.",
    ),
    ...tool(
      session,
      "Edit",
      {
        file_path: "src/app.ts",
        old_string: "import { rateLimit } from \"./middleware/rate-limit.ts\";",
        new_string: "import { redis } from \"./lib/redis.ts\";\nimport { rateLimit } from \"./middleware/rate-limit.ts\";\nimport { MemoryRateLimitStore } from \"./middleware/rate-limit-store.ts\";\nimport { RedisRateLimitStore } from \"./middleware/redis-rate-limit-store.ts\";",
      },
      "The file src/app.ts has been updated successfully.",
    ),
    ...tool(session, "Bash", { command: "npm run typecheck", description: "Type-check the project" }, "", { seconds: 9 }),
    ...tool(
      session,
      "Agent",
      {
        description: "Review the Lua script for races",
        subagent_type: "general-purpose",
        prompt: "Review src/middleware/redis-rate-limit-store.ts. Can two replicas hitting the same key at the same moment lose a count, or leave a key without an expiry? Answer briefly with any concrete failure.",
      },
      "No lost counts: the script runs atomically, so concurrent INCRs serialise.\n\nOne edge: if PEXPIRE fails after INCR (it can't for a valid key, but e.g. a replica's script is killed by SCRIPT KILL between the two calls), the key has no TTL and the client stays limited forever. Cheap guard: also set the expiry when PTTL returns -1.",
      { seconds: 25 },
    ),
    text(
      session,
      "Good catch from the review. A key without a TTL would block a client permanently, so I'll make the script repair that case too. It costs nothing on the hot path.",
    ),
    ...tool(
      session,
      "Edit",
      {
        file_path: "src/middleware/redis-rate-limit-store.ts",
        old_string: "if count == 1 then redis.call(\"PEXPIRE\", KEYS[1], ARGV[1]) end\nreturn { count, redis.call(\"PTTL\", KEYS[1]) }",
        new_string: "local ttl = redis.call(\"PTTL\", KEYS[1])\nif count == 1 or ttl == -1 then\n  redis.call(\"PEXPIRE\", KEYS[1], ARGV[1])\n  ttl = tonumber(ARGV[1])\nend\nreturn { count, ttl }",
      },
      "The file src/middleware/redis-rate-limit-store.ts has been updated successfully.",
    ),
    ...todos(session, PLAN, 3),
    ...tool(session, "Write", { file_path: "src/middleware/rate-limit-store.test.ts", content: TEST_TS }, "File created successfully at: src/middleware/rate-limit-store.test.ts"),
    ...tool(
      session,
      "Bash",
      { command: "docker compose up -d redis && REDIS_URL=redis://localhost:6379 npx vitest run src/middleware", description: "Run the middleware tests against a local Redis" },
      " ✓ memory store > counts hits in a window and starts a new one after it\n ✓ memory store > counts concurrent hits exactly once each\n × redis store > counts hits in a window and starts a new one after it\n   → expected 3 to be 1\n ✓ redis store > counts concurrent hits exactly once each\n ✓ rate-limit.test.ts (6 tests)\n\n Tests  1 failed | 9 passed (10)",
      { isError: true, seconds: 14 },
    ),
    text(
      session,
      "The Redis window test fails because faking `Date` doesn't move Redis's clock: the key's TTL is real time, so it hasn't expired after the fake 1 s. For Redis I'll use a short real window instead of fake timers. The concurrency test passes for both stores, which is the property that matters most.",
      5,
    ),
    ...tool(
      session,
      "Edit",
      {
        file_path: "src/middleware/rate-limit-store.test.ts",
        old_string: "    expect((await store.hit(\"a\", 1000)).count).toBe(1);\n    expect((await store.hit(\"a\", 1000)).count).toBe(2);\n    vi.advanceTimersByTime(1000);\n    expect((await store.hit(\"a\", 1000)).count).toBe(1);",
        new_string: "    vi.useRealTimers();\n    expect((await store.hit(\"a\", 50)).count).toBe(1);\n    expect((await store.hit(\"a\", 50)).count).toBe(2);\n    await new Promise((resolve) => setTimeout(resolve, 80));\n    expect((await store.hit(\"a\", 50)).count).toBe(1);",
      },
      "The file src/middleware/rate-limit-store.test.ts has been updated successfully.",
    ),
    ...tool(
      session,
      "Bash",
      { command: "REDIS_URL=redis://localhost:6379 npm test", description: "Run the whole test suite" },
      " Test Files  14 passed (14)\n      Tests  118 passed (118)\n   Duration  8.21s",
      { seconds: 16 },
    ),
    ...todos(session, PLAN, 4),
    ...tool(
      session,
      "Edit",
      {
        file_path: "README.md",
        old_string: "| `RATE_LIMIT_MAX` | `100` | Requests per window. |",
        new_string: "| `RATE_LIMIT_MAX` | `100` | Requests per window. |\n| `RATE_LIMIT_STORE` | `redis` in production, else `memory` | Where requests are counted. `redis` shares the limit across replicas; `memory` counts per process. |",
      },
      "The file README.md has been updated successfully.",
    ),
    ...todos(session, PLAN, 5),
    ...tool(
      session,
      "Bash",
      { command: "git status --short && git diff --stat", description: "Summarise the changes" },
      " M README.md\n M src/app.ts\n M src/config.ts\n M src/middleware/rate-limit.ts\n?? src/middleware/rate-limit-store.test.ts\n?? src/middleware/rate-limit-store.ts\n?? src/middleware/redis-rate-limit-store.ts\n 4 files changed, 21 insertions(+), 15 deletions(-)",
    ),
    ...answer(
      session,
      "Rate limits are now shared across replicas through Redis.\n\n" +
        "**What changed**\n" +
        "- `RateLimitStore` interface with two implementations: `MemoryRateLimitStore` (the old logic) and `RedisRateLimitStore`.\n" +
        "- The Redis store counts with one Lua script per request: `INCR`, the window's expiry on the first hit, and the remaining TTL, in **one round trip**, atomically. It also restores a missing expiry, which a subagent review flagged as a way to block a client forever.\n" +
        "- `RATE_LIMIT_STORE` picks the store: `redis` in production, `memory` elsewhere. Documented in the README.\n" +
        "- Headers are unchanged (`X-RateLimit-Limit`, `-Remaining`, `-Reset`, `Retry-After`).\n\n" +
        "**Behaviour to know about**\n" +
        "- If Redis is down, requests are let through and a warning is logged (fail open).\n" +
        "- Keys now expire with their window, so the old unbounded `Map` growth is gone.\n\n" +
        "**Tests**: new tests run against both stores, including 50 concurrent hits counted exactly once. The full suite passes (118 tests).",
      31,
      2.84,
    ),
  ];
}

interface SeedRun {
  status: Run["status"];
  prompt: string;
  /** Minutes before now that the run started. */
  minutesAgo: number;
  error?: string;
  stderr?: string;
  messages?: { prompt: string; afterSeconds: number }[];
  /** Builds the run's events; `session` is the conversation's session id. */
  steps: (session: string) => Step[];
}

interface SeedConversation {
  id: string;
  repository?: string;
  openPr?: boolean;
  pushed?: boolean;
  runs: SeedRun[];
}

const conversations: SeedConversation[] = [
  {
    id: "seed-redis-rate-limiter",
    repository: "https://github.com/example/demo-api",
    openPr: true,
    pushed: true,
    runs: [{ status: "finished", prompt: LONG_TASK_PROMPT, minutesAgo: 60 * 3, steps: longTask }],
  },
  {
    id: "seed-fix-readme-typos",
    repository: "https://github.com/example/demo-app",
    openPr: true,
    pushed: true,
    runs: [
      {
        status: "finished",
        prompt: "Fix the typos in README.md\n\nThe install section says `npm instal` and 'recieve'.",
        minutesAgo: 60 * 26,
        steps: (session) => [
          init(session),
          text(session, "I'll look at the README first."),
          ...tool(session, "Read", { file_path: "README.md" }, "# Demo app\n\nRun `npm instal` to recieve the deps."),
          ...tool(
            session,
            "Edit",
            { file_path: "README.md", old_string: "npm instal` to recieve", new_string: "npm install` to receive" },
            "The file README.md has been updated.",
          ),
          ...answer(session, "Fixed both typos in README.md: `npm instal` → `npm install` and `recieve` → `receive`.", 3, 0.042),
        ],
      },
      {
        status: "finished",
        prompt: "Also check CONTRIBUTING.md for the same mistakes.",
        minutesAgo: 60 * 25,
        steps: (session) => [
          init(session),
          ...tool(session, "Grep", { pattern: "instal\\b|recieve", path: "." }, "CONTRIBUTING.md:12: npm instal"),
          ...tool(
            session,
            "Edit",
            { file_path: "CONTRIBUTING.md", old_string: "npm instal", new_string: "npm install" },
            "The file CONTRIBUTING.md has been updated.",
          ),
          ...answer(session, "CONTRIBUTING.md had one more `npm instal` on line 12; fixed it. No other matches in the repository.", 2, 0.031),
        ],
      },
    ],
  },
  {
    id: "seed-explain-retry-logic",
    runs: [
      {
        status: "finished",
        prompt: "How does exponential backoff with jitter work? Keep it short.",
        minutesAgo: 60 * 5,
        steps: (session) => [
          init(session),
          ...answer(
            session,
            "Each retry waits roughly twice as long as the last (100 ms, 200 ms, 400 ms, ...), capped at a maximum. " +
              "Jitter picks a random wait between 0 and that value, so clients that failed together don't retry together.",
            1,
            0.008,
          ),
        ],
      },
    ],
  },
  {
    id: "seed-flaky-integration-test",
    repository: "https://github.com/example/demo-app",
    runs: [
      {
        status: "failed",
        prompt: "The `checkout flow` integration test fails about one run in five. Find out why and fix it.",
        minutesAgo: 90,
        error: "Claude Code exited with code 1",
        stderr: "Error: Reached maximum number of turns (40)",
        steps: (session) => [
          init(session),
          ...tool(session, "Bash", { command: "npm test -- -t 'checkout flow'" }, "Tests: 1 passed, 1 total"),
          ...tool(session, "Bash", { command: "for i in $(seq 10); do npm test -- -t 'checkout flow' || break; done" }, "Error: connect ECONNREFUSED 127.0.0.1:6379", { isError: true }),
          text(session, "It fails when Redis isn't up yet. Looking at the test setup."),
          {
            seconds: 4,
            event: {
              type: "result",
              subtype: "error_max_turns",
              is_error: true,
              session_id: session,
              num_turns: 40,
              duration_ms: 612_000,
              total_cost_usd: 1.37,
            },
          },
        ],
      },
    ],
  },
  {
    id: "seed-upgrade-dependencies",
    repository: "https://github.com/example/demo-app",
    runs: [
      {
        status: "cancelled",
        prompt: "Upgrade every dependency to its latest major version.",
        minutesAgo: 40,
        steps: (session) => [
          init(session),
          ...tool(session, "Bash", { command: "npx npm-check-updates" }, "react 18.3.1 → 19.2.0\nvitest 3.2.4 → 4.1.12\n... 23 more"),
          text(session, "25 packages have new majors. Starting with React."),
        ],
      },
    ],
  },
  {
    id: "seed-add-health-endpoint",
    repository: "https://github.com/example/demo-api",
    openPr: true,
    pushed: true,
    runs: [
      {
        status: "finished",
        prompt: "Add a GET /health endpoint that returns { ok: true }.",
        minutesAgo: 15,
        messages: [{ prompt: "Add a test for it too.", afterSeconds: 5 }],
        steps: (session) => [
          init(session),
          ...tool(session, "Read", { file_path: "src/routes.ts" }, "export const routes = [\n  ['GET', '/users', listUsers],\n];"),
          ...tool(
            session,
            "Edit",
            { file_path: "src/routes.ts", old_string: "export const routes = [", new_string: "export const routes = [\n  ['GET', '/health', () => ({ ok: true })]," },
            "The file src/routes.ts has been updated.",
          ),
          ...tool(
            session,
            "Write",
            { file_path: "src/health.test.ts", content: "test('GET /health', async () => {\n  expect(await get('/health')).toEqual({ ok: true });\n});\n" },
            "File created successfully at: src/health.test.ts",
          ),
          ...tool(session, "Bash", { command: "npm test" }, "Tests: 14 passed, 14 total"),
          ...answer(session, "Added `GET /health` returning `{ ok: true }` in src/routes.ts, with a test in src/health.test.ts. All 14 tests pass.", 6, 0.118),
        ],
      },
    ],
  },
];

const connectionString = process.env.DB_CONNECTION_STRING;
if (!connectionString) {
  console.error("DB_CONNECTION_STRING is not set (add it to .env or the environment).");
  process.exit(1);
}

const store = new Store(connectionString);
let created = 0;
let skipped = 0;
try {
  await store.migrate();
  const known = new Set((await store.loadConversations()).map((conversation) => conversation.id));
  for (const seed of conversations) {
    if (known.has(seed.id)) {
      skipped += 1;
      continue;
    }
    await seedConversation(seed);
    created += 1;
    console.log(`seeded ${seed.id} (${seed.runs.length} run${seed.runs.length === 1 ? "" : "s"})`);
  }
  await store.flush();
  console.log(`Done: ${created} seeded, ${skipped} already in the database.`);
} catch (error) {
  console.error("Seeding failed:", error instanceof Error ? error.message : error);
  process.exitCode = 1;
} finally {
  await store.close();
}

async function seedConversation(seed: SeedConversation) {
  const sessionId = randomUUID();
  const conversation: Conversation = {
    id: seed.id,
    title: seed.runs[0]!.prompt.split("\n")[0]!.slice(0, 80),
    sessionId,
    sessionStarted: true,
    openPr: seed.openPr ?? false,
    pushed: seed.pushed ?? false,
    runs: [],
    ...(seed.repository
      ? {
          repository: seed.repository,
          branch: `agent/${seed.id.slice(0, 12)}`,
          baseCommit: "0000000000000000000000000000000000000000",
        }
      : {}),
    ...(seed.openPr && seed.pushed ? { prUrl: `${seed.repository}/pull/${100 + created}` } : {}),
  };
  await store.saveConversation(conversation);

  for (const [index, seedRun] of seed.runs.entries()) {
    const startedAt = new Date(Date.now() - seedRun.minutesAgo * 60_000);
    let at = startedAt;
    const steps = seedRun.steps(sessionId);
    const finishedAt = new Date(startedAt.getTime() + steps.reduce((sum, step) => sum + step.seconds, 0) * 1000 + 1000);
    const run: Run = {
      id: randomUUID(),
      status: seedRun.status,
      prompt: seedRun.prompt,
      startedAt: startedAt.toISOString(),
      finishedAt: finishedAt.toISOString(),
      ...(seedRun.error ? { error: seedRun.error } : {}),
      ...(seedRun.stderr ? { stderr: seedRun.stderr } : {}),
    };
    await store.saveRun(seed.id, index + 1, run);
    for (const [position, message] of (seedRun.messages ?? []).entries()) {
      const runMessage: RunMessage = {
        id: randomUUID(),
        prompt: message.prompt,
        sentAt: new Date(startedAt.getTime() + message.afterSeconds * 1000).toISOString(),
      };
      await store.saveRunMessage(seed.id, run.id, position + 1, runMessage);
    }
    for (const [position, step] of steps.entries()) {
      at = new Date(at.getTime() + step.seconds * 1000);
      store.saveEvent(seed.id, run.id, position + 1, at, step.event);
    }
  }
}
