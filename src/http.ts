import type { IncomingMessage, ServerResponse } from "node:http";
import type { AvailabilityQuery, ConversationView, ConversationRunner, Image, LaunchRequest, PromptRequest, RunMessage } from "./runner.ts";
import { log, since } from "./log.ts";
import { CheckoutDirty, CheckoutMissing, ConversationBusy, RunNotRunning, checkoutName } from "./runner.ts";
import type { LiveOp, PageOptions } from "./ui.ts";
import { LiveRunRenderer, conversationsPage, sidePanels, transcriptPage } from "./ui.ts";

const MAX_BODY_BYTES = 128 * 1024 * 1024;
const MAX_PROMPT_CHARS = 100_000;
const MAX_IMAGES = 5;
const MIME_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
const ID = "[A-Za-z0-9_-]{1,128}";
const ID_ONLY = new RegExp(`^${ID}$`);
// `/conversations` is canonical. `/agents` is Rakazo's name for a conversation and stays
// as an alias, because the fork's Coder adapter calls those paths.
const BASE = "/(?:conversations|agents)";
const CONVERSATION = new RegExp(`^${BASE}/(${ID})$`);
const RUNS = new RegExp(`^${BASE}/(${ID})/runs$`);
const RUN = new RegExp(`^${BASE}/(${ID})/runs/(${ID})$`);
const CANCEL = new RegExp(`^${BASE}/(${ID})/runs/(${ID})/cancel$`);
const MESSAGES = new RegExp(`^${BASE}/(${ID})/runs/(${ID})/messages$`);
const UI = new RegExp(`^/ui${BASE}/(${ID})$`);
const UI_LIST = /^\/ui\/(conversations|agents)(\/?)$/;
const UI_STREAM = new RegExp(`^/ui${BASE}/(${ID})/stream$`);

/** How long changes to the page are gathered before they are sent together. */
const STREAM_BATCH_MS = 100;
/** How often the sidebars (cost, counts, conversation list) are re-sent while a run goes. */
const STREAM_PANELS_MS = 5_000;
/** Keeps proxies from closing a quiet stream; the page also treats silence as a lost stream. */
const STREAM_PING_MS = 15_000;

/** `html` is only for the browser page; everything Rakazo calls stays JSON. */
type Reply = { status: number; body: unknown; html?: string };

/** JSON API over the runner. Listens on loopback only; Coder's app proxy authenticates callers. */
export function createHandler(runner: ConversationRunner, pages: PageOptions = {}) {
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
    let live: RegExpExecArray | null;
    try {
      live = UI_STREAM.exec(new URL(request.url ?? "/", "http://runner").pathname);
      if (live && request.method === "GET") {
        stream(runner, pages, live[1]!, request, response);
        logRequest(request, response.statusCode, since(started));
        return;
      }
    } catch (error) {
      failed(error);
      return;
    }
    route(runner, pages, request)
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
      .then(({ status, body, html }) => {
        // Serialized before the headers go out, so a body that cannot be serialized still gets `internal`.
        const text = html ?? JSON.stringify(body);
        logRequest(request, status, since(started));
        response.writeHead(status, { "content-type": html !== undefined ? "text/html; charset=utf-8" : "application/json" });
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

async function route(runner: ConversationRunner, pages: PageOptions, request: IncomingMessage): Promise<Reply> {
  const url = new URL(request.url ?? "/", "http://runner");
  const pathname = url.pathname;
  const method = request.method ?? "GET";
  if (pathname === "/health" && method === "GET") return { status: 200, body: { ok: true } };
  if (pathname === "/workspace" && method === "GET") return { status: 200, body: await runner.workspace() };
  if (pathname === "/availability" && method === "GET") {
    const availability = await runner.availability(availabilityQuery(url.searchParams));
    return availability ? { status: 200, body: availability } : { status: 404, body: { code: "not_found" } };
  }
  const conversation = CONVERSATION.exec(pathname);
  if (conversation && method === "PUT") {
    const body = launchRequest(await readJson(request));
    return found(await runner.launch(conversation[1]!, body));
  }
  if (conversation && method === "GET") return found(runner.get(conversation[1]!));
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
  const ui = UI.exec(pathname);
  if (ui && method === "GET") {
    const transcript = await runner.transcript(ui[1]!);
    if (!transcript) return { status: 404, body: { code: "not_found" } };
    return { status: 200, body: null, html: transcriptPage(transcript, runner.list(), await runner.workspace(), pages) };
  }
  const uiList = UI_LIST.exec(pathname);
  if (uiList && method === "GET") {
    // Relative links: `/ui/conversations` needs `conversations/<id>`, `/ui/conversations/` needs `./<id>`.
    const hrefPrefix = uiList[2] ? "./" : `${uiList[1]}/`;
    return { status: 200, body: null, html: conversationsPage(runner.list(), await runner.workspace(), hrefPrefix, pages) };
  }
  return { status: 404, body: { code: "route_not_found" } };
}

/**
 * `GET /ui/conversations/:id/stream?run=<runId>&after=<n>`: server-sent events for the open
 * transcript page, which says which run it shows as running (`run`) and how many of its events
 * it has (`after`). Sends `patch` ({ seq, ops }) for each batch of new events, and `reload` when
 * the page is out of date (a run started or ended), after which the stream ends. A page showing
 * no running run waits here for the next one to start.
 */
function stream(runner: ConversationRunner, pages: PageOptions, id: string, request: IncomingMessage, response: ServerResponse) {
  const conversation = runner.get(id);
  if (!conversation) {
    response.writeHead(404, { "content-type": "application/json" });
    response.end(JSON.stringify({ code: "not_found" }));
    return;
  }
  const params = new URL(request.url ?? "/", "http://runner").searchParams;
  const pageRun = params.get("run") ?? "";
  const after = Number(params.get("after") ?? "0");
  const messagesShown = Number(params.get("messages") ?? "0");
  response.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache, no-transform",
    // Asks nginx-style proxies not to buffer the stream.
    "x-accel-buffering": "no",
  });
  const send = (event: string, data: unknown) => response.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  send("ready", {});

  const timers = new Set<NodeJS.Timeout>();
  const later = (ms: number, run: () => void) => {
    const timer = setTimeout(() => {
      timers.delete(timer);
      run();
    }, ms);
    timers.add(timer);
    return timer;
  };
  let unsubscribe = () => {};
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    unsubscribe();
    for (const timer of timers) clearTimeout(timer);
    response.end();
  };
  response.on("close", close);
  const reload = () => {
    send("reload", {});
    close();
  };

  const attach = () => {
    const liveRun = runner.liveRun(id);
    if (!pageRun) {
      // The page shows no run going: it needs to hear when one starts, and when any run takes or
      // gives back the root, since that changes what its message box can do.
      if (liveRun) return reload();
      const unsubscribeRun = runner.subscribe(id, (update) => {
        if (update.type === "start" || update.type === "end") reload();
      });
      const unwatch = runner.watch(reload);
      unsubscribe = () => {
        unsubscribeRun();
        unwatch();
      };
    } else {
      if (!liveRun || liveRun.runId !== pageRun || !Number.isInteger(after) || after < 0 || after > liveRun.events.length || !Number.isInteger(messagesShown) || messagesShown < 0 || messagesShown > liveRun.messages.length)
        return reload();
      const renderer = new LiveRunRenderer(pageRun, liveRun.startedAt);
      let pending: LiveOp[] = [];
      let batch: NodeJS.Timeout | undefined;
      const flush = () => {
        batch = undefined;
        if (closed) return;
        send("patch", { seq: renderer.count, messages: messageCount, ops: [...pending, renderer.activity()] });
        pending = [];
      };
      const take = (event: Parameters<LiveRunRenderer["push"]>[0]) => {
        for (const op of renderer.push(event)) {
          // A later re-render of the same element replaces an earlier one still waiting.
          if (op.op === "replace") pending = pending.filter((item) => item.op !== "replace" || item.id !== op.id);
          pending.push(op);
        }
        batch ??= later(STREAM_BATCH_MS, flush);
      };
      let messageCount = messagesShown;
      const takeMessage = (message: RunMessage) => {
        messageCount += 1;
        pending.push(renderer.message(message));
        batch ??= later(STREAM_BATCH_MS, flush);
      };
      liveRun.events.forEach((event, index) => (index < after ? renderer.push(event, false) : take(event)));
      liveRun.messages.slice(messagesShown).forEach(takeMessage);
      // Nothing awaits between reading the events and subscribing, so none can slip through.
      unsubscribe = runner.subscribe(id, (update) => {
        if (update.type === "event" && update.runId === pageRun) take(update.event);
        else if (update.type === "message" && update.runId === pageRun) takeMessage(update.message);
        else if (update.type === "start" || update.type === "end") {
          if (batch) flush();
          reload();
        }
      });
      const panels = async () => {
        const [transcript, workspace] = await Promise.all([runner.transcript(id), runner.workspace()]).catch(() => []);
        if (closed) return;
        if (transcript && workspace) send("patch", { ops: sidePanels(transcript, runner.list(), workspace, pages) });
        later(STREAM_PANELS_MS, panels);
      };
      later(STREAM_PANELS_MS, panels);
    }
    const ping = () => {
      if (closed) return;
      send("ping", {});
      later(STREAM_PING_MS, ping);
    };
    later(STREAM_PING_MS, ping);
  };
  // The page reconnects after a lost stream, so a failure here ends the stream and lets it come
  // back; the rest of the service is untouched.
  try {
    attach();
  } catch (error) {
    log.error("stream failed", { conversation: id, error: error instanceof Error ? (error.stack ?? error.message) : String(error) });
    close();
  }
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
  if (repository !== undefined) {
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
