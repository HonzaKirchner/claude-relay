import type { IncomingMessage, ServerResponse } from "node:http";
import type { AvailabilityQuery, ConversationView, ConversationRunner, Image, LaunchRequest, PromptRequest } from "./runner.ts";
import { log, since } from "./log.ts";
import { CheckoutDirty, CheckoutMissing, ConversationBusy, NO_REPOSITORY, RunNotRunning, checkoutName } from "./runner.ts";
import type { SecretStore, Secrets } from "./secrets.ts";
import { SECRET_KEYS } from "./secrets.ts";

const MAX_BODY_BYTES = 128 * 1024 * 1024;
const MAX_PROMPT_CHARS = 100_000;
const MAX_IMAGES = 5;
const MIME_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
const ID = "[A-Za-z0-9_-]{1,128}";
const ID_ONLY = new RegExp(`^${ID}$`);
// `/conversations` is canonical. `/agents` is Rakazo's name for a conversation and stays
// as an alias, because the fork's `apify-remote-platform` adapter calls those paths.
const BASE = "/(?:conversations|agents)";
const LIST = new RegExp(`^${BASE}/?$`);
const CONVERSATION = new RegExp(`^${BASE}/(${ID})$`);
const TRANSCRIPT = new RegExp(`^${BASE}/(${ID})/transcript$`);
const RUNS = new RegExp(`^${BASE}/(${ID})/runs$`);
const RUN = new RegExp(`^${BASE}/(${ID})/runs/(${ID})$`);
const CANCEL = new RegExp(`^${BASE}/(${ID})/runs/(${ID})/cancel$`);
const MESSAGES = new RegExp(`^${BASE}/(${ID})/runs/(${ID})/messages$`);
/** The longest a secret may be: a token, or a URL. */
const MAX_SECRET_CHARS = 4096;

type Reply = { status: number; body: unknown };

/** JSON API over the runner. Listens on loopback only; Coder's app proxy authenticates callers. */
export function createHandler(runner: ConversationRunner, secrets: SecretStore) {
  return (request: IncomingMessage, response: ServerResponse) => {
    const started = performance.now();
    // Nothing escapes the handler: a throw here would be an uncaught exception, and the client
    // would get a dropped connection instead of an error. Answers `internal` while it still can;
    // once the headers are out (a stream), all that is left is to end the connection.
    const failed = (error: unknown) => {
      log.error("request failed", {
        method: request.method,
        path: request.url,
        error: error instanceof Error ? (error.stack ?? error.message) : String(error),
      });
      logRequest(request, 500, since(started));
      try {
        if (response.headersSent) response.destroy();
        else {
          response.writeHead(500, { "content-type": "application/json" });
          response.end(JSON.stringify({ code: "internal" }));
        }
      } catch {
        response.destroy();
      }
    };
    route(runner, secrets, request)
      .catch((error: unknown): Reply => {
        // One run at a time across the root. `busy` is the code Rakazo knows; `reason` and the rest
        // are additive: `locked` names the conversation whose run is going, `dirty` the checkout
        // with uncommitted changes to deal with by hand and the branch it is on.
        if (error instanceof ConversationBusy)
          return { status: 409, body: { code: "busy", reason: "locked", conversation: error.conversation } };
        if (error instanceof CheckoutDirty)
          return { status: 409, body: { code: "busy", reason: "dirty", branch: error.branch, path: error.path } };
        if (error instanceof RunNotRunning) return { status: 409, body: { code: "not_running" } };
        // The repository is not cloned where it should be: someone has to do that in the workspace,
        // so Rakazo rightly gives the request up (`invalid`). `reason` and the rest are additive.
        if (error instanceof CheckoutMissing)
          return {
            status: 400,
            body: {
              code: "invalid",
              reason: "no_checkout",
              path: error.path,
              ...(error.repository ? { repository: error.repository } : {}),
              ...(error.found ? { found: error.found } : {}),
            },
          };
        // What the request got wrong, for the log and, additively, for the caller (`detail`), since
        // Rakazo shows nothing of a rejected request. Never the prompt itself.
        if (error instanceof InvalidRequest) {
          log.warn("request rejected", { method: request.method, path: request.url, reason: error.message });
          return { status: 400, body: { code: "invalid", detail: error.message } };
        }
        log.error("request failed", {
          method: request.method,
          path: request.url,
          error: error instanceof Error ? (error.stack ?? error.message) : String(error),
        });
        return { status: 500, body: { code: "internal" } };
      })
      .then(({ status, body }) => {
        // Serialized before the headers go out, so a body that cannot be serialized still gets `internal`.
        const text = JSON.stringify(body);
        logRequest(request, status, since(started));
        response.writeHead(status, { "content-type": "application/json" });
        response.end(text);
      })
      .catch(failed);
  };
}

/** Writes and errors at info; reads (Rakazo polls often) and health checks only at debug. */
function logRequest(request: IncomingMessage, status: number, ms: number) {
  const fields = { method: request.method, path: request.url, status, ms };
  if (status >= 500) log.error("request", fields);
  else if (status >= 400 && status !== 404 && status !== 409) log.warn("request", fields);
  else if (request.method === "GET" || request.method === "HEAD") log.debug("request", fields);
  else log.info("request", fields);
}

async function route(runner: ConversationRunner, secrets: SecretStore, request: IncomingMessage): Promise<Reply> {
  const url = new URL(request.url ?? "/", "http://runner");
  const pathname = url.pathname;
  const method = request.method ?? "GET";
  if (pathname === "/health" && method === "GET") return { status: 200, body: { ok: true } };
  if (pathname === "/workspace" && method === "GET") return { status: 200, body: await runner.workspace() };
  if (pathname === "/secrets" && method === "PUT") {
    await secrets.set(secretsRequest(await readJson(request)));
    // Which are there now, never what they are.
    return { status: 200, body: secrets.present() };
  }
  if (pathname === "/availability" && method === "GET") {
    const availability = await runner.availability(availabilityQuery(url.searchParams));
    return availability ? { status: 200, body: availability } : { status: 404, body: { code: "not_found" } };
  }
  if (LIST.test(pathname) && method === "GET") return { status: 200, body: { conversations: runner.list() } };
  const conversation = CONVERSATION.exec(pathname);
  if (conversation && method === "PUT") {
    const body = launchRequest(await readJson(request));
    return found(await runner.launch(conversation[1]!, body));
  }
  if (conversation && method === "GET") return found(runner.get(conversation[1]!));
  const transcript = TRANSCRIPT.exec(pathname);
  if (transcript && method === "GET") {
    // Everything about the conversation, for whoever keeps and shows it; `have` leaves out the events it holds.
    const found = await runner.transcript(transcript[1]!, haveQuery(url.searchParams));
    return found ? { status: 200, body: found } : { status: 404, body: { code: "not_found" } };
  }
  const runs = RUNS.exec(pathname);
  if (runs && method === "POST")
    return found(await runner.reply(runs[1]!, promptRequest(await readJson(request))));
  const run = RUN.exec(pathname);
  if (run && method === "GET") return found(runner.get(run[1]!, run[2]!));
  const cancel = CANCEL.exec(pathname);
  if (cancel && method === "POST") return found(await runner.cancel(cancel[1]!, cancel[2]!));
  const messages = MESSAGES.exec(pathname);
  if (messages && method === "POST")
    return found(await runner.steer(messages[1]!, messages[2]!, promptRequest(await readJson(request))));
  return { status: 404, body: { code: "route_not_found" } };
}

function found(view: ConversationView | undefined): Reply {
  return view ? { status: 200, body: view } : { status: 404, body: { code: "not_found" } };
}

/** A request the service refuses before touching the runner; `message` says what is wrong with it. */
class InvalidRequest extends Error {}

function promptRequest(value: unknown): PromptRequest {
  if (!isObject(value)) throw new InvalidRequest("the body is not a JSON object");
  const { prompt, images } = value;
  if (typeof prompt !== "string") throw new InvalidRequest(`prompt is ${describe(prompt)}, not a string`);
  if (!prompt.trim()) throw new InvalidRequest("prompt is blank");
  if (prompt.length > MAX_PROMPT_CHARS) throw new InvalidRequest(`prompt is ${prompt.length} characters, over ${MAX_PROMPT_CHARS}`);
  if (images === undefined) return { prompt };
  if (!Array.isArray(images)) throw new InvalidRequest(`images is ${describe(images)}, not an array`);
  if (images.length > MAX_IMAGES) throw new InvalidRequest(`images has ${images.length} entries, over ${MAX_IMAGES}`);
  return { prompt, images: images.map((item, index) => image(item, index)) };
}

function launchRequest(value: unknown): LaunchRequest {
  const request: LaunchRequest = promptRequest(value);
  const { repository, openPr, baseBranch } = value as Record<string, unknown>;
  if (repository === NO_REPOSITORY) request.repository = repository;
  else if (repository !== undefined) {
    if (typeof repository !== "string") throw new InvalidRequest(`repository is ${describe(repository)}, not a string`);
    if (!URL.canParse(repository)) throw new InvalidRequest(`repository ${JSON.stringify(repository)} is not a URL`);
    if (new URL(repository).protocol !== "https:") throw new InvalidRequest(`repository ${JSON.stringify(repository)} is not an https URL`);
    if (!checkoutName(repository)) throw new InvalidRequest(`repository ${JSON.stringify(repository)} does not end in a repository name`);
    request.repository = repository;
  }
  if (openPr !== undefined) {
    if (typeof openPr !== "boolean") throw new InvalidRequest(`openPr is ${describe(openPr)}, not a boolean`);
    request.openPr = openPr;
  }
  if (baseBranch !== undefined) {
    if (typeof baseBranch !== "string") throw new InvalidRequest(`baseBranch is ${describe(baseBranch)}, not a string`);
    if (!BRANCH_NAME.test(baseBranch)) throw new InvalidRequest(`baseBranch ${JSON.stringify(baseBranch)} is not a branch name`);
    request.baseBranch = baseBranch;
  }
  return request;
}

/** `GET /availability?conversation=<id>`: the conversation a follow-up would be of, if any. */
function availabilityQuery(params: URLSearchParams): AvailabilityQuery {
  const conversation = params.get("conversation");
  if (conversation === null) return {};
  if (!ID_ONLY.test(conversation)) throw new InvalidRequest("conversation is not a conversation id");
  return { conversation };
}

/** `?have=<runId>:<count>,...`: how many of each run's events the caller already holds. */
function haveQuery(params: URLSearchParams): Map<string, number> {
  const have = new Map<string, number>();
  for (const entry of (params.get("have") ?? "").split(",")) {
    if (!entry) continue;
    const [runId, count, ...rest] = entry.split(":");
    if (!runId || !ID_ONLY.test(runId) || !/^\d{1,9}$/.test(count ?? "") || rest.length)
      throw new InvalidRequest("have is not a list of runId:count");
    have.set(runId, Number(count));
  }
  return have;
}

function secretsRequest(value: unknown): Secrets {
  if (!isObject(value)) throw new InvalidRequest("the body is not a JSON object");
  const secrets: Secrets = {};
  for (const key of SECRET_KEYS) {
    const secret = value[key];
    if (secret === undefined) continue;
    // Never the value itself in the reason.
    if (typeof secret !== "string" || !secret.trim() || secret.length > MAX_SECRET_CHARS || /[\r\n\0]/.test(secret.trim()))
      throw new InvalidRequest(`${key} is not a single line of at most ${MAX_SECRET_CHARS} characters`);
    secrets[key] = secret.trim();
  }
  if (secrets.platformUrl !== undefined && !/^https?:\/\//.test(secrets.platformUrl)) throw new InvalidRequest("platformUrl is not a URL");
  return secrets;
}

/** A plain branch name: what `git check-ref-format --branch` allows, without the odd corners, and never an option. */
const BRANCH_NAME = /^(?!-)(?!.*(?:\.\.|@\{|\/\/|\/$|\.$|\.lock$))[^\s~^:?*[\\\x00-\x1f\x7f]{1,255}$/;

function image(value: unknown, index: number): Image {
  if (!isObject(value)) throw new InvalidRequest(`images[${index}] is ${describe(value)}, not an object`);
  if (value.url !== undefined) {
    if (typeof value.url === "string" && URL.canParse(value.url)) return { url: value.url };
    throw new InvalidRequest(`images[${index}].url is not a URL`);
  }
  if (typeof value.data !== "string") throw new InvalidRequest(`images[${index}] has neither url nor data`);
  if (typeof value.mimeType !== "string" || !MIME_TYPES.has(value.mimeType))
    throw new InvalidRequest(`images[${index}].mimeType is ${describe(value.mimeType)}, not one of ${[...MIME_TYPES].join(", ")}`);
  return { data: value.data, mimeType: value.mimeType };
}

/** What a value is, for a rejection's reason: its type, or its value when that is short and not text. */
function describe(value: unknown) {
  if (value === null) return "null";
  if (value === undefined) return "missing";
  if (typeof value === "string") return "a string";
  if (Array.isArray(value)) return "an array";
  if (typeof value === "object") return "an object";
  return `${typeof value} ${String(value)}`;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) throw new InvalidRequest(`the body is over ${MAX_BODY_BYTES} bytes`);
    chunks.push(chunk as Buffer);
  }
  const text = Buffer.concat(chunks).toString("utf8");
  if (!text.trim()) throw new InvalidRequest("the body is empty");
  try {
    return JSON.parse(text);
  } catch {
    // Not the parser's message: it quotes the body, which may hold the prompt.
    throw new InvalidRequest("the body is not JSON");
  }
}
