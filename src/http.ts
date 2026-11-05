import type { IncomingMessage, ServerResponse } from "node:http";
import type { ConversationView, ConversationRunner, Image, LaunchRequest, PromptRequest } from "./runner.ts";
import { log, since } from "./log.ts";
import { ConversationBusy } from "./runner.ts";
import { transcriptPage } from "./ui.ts";

const MAX_BODY_BYTES = 128 * 1024 * 1024;
const MIME_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
const ID = "[A-Za-z0-9_-]{1,128}";
// `/conversations` is canonical. `/agents` is Rakazo's name for a conversation and stays
// as an alias, because the fork's Coder adapter calls those paths.
const BASE = "/(?:conversations|agents)";
const CONVERSATION = new RegExp(`^${BASE}/(${ID})$`);
const RUNS = new RegExp(`^${BASE}/(${ID})/runs$`);
const RUN = new RegExp(`^${BASE}/(${ID})/runs/(${ID})$`);
const CANCEL = new RegExp(`^${BASE}/(${ID})/runs/(${ID})/cancel$`);
const UI = new RegExp(`^/ui${BASE}/(${ID})$`);

/** `html` is only for the browser page; everything Rakazo calls stays JSON. */
type Reply = { status: number; body: unknown; html?: string };

/** JSON API over the runner. Listens on loopback only; Coder's app proxy authenticates callers. */
export function createHandler(runner: ConversationRunner) {
  return (request: IncomingMessage, response: ServerResponse) => {
    const started = performance.now();
    route(runner, request)
      .catch((error: unknown): Reply => {
        if (error instanceof ConversationBusy) return { status: 409, body: { code: "busy" } };
        if (error instanceof InvalidRequest) return { status: 400, body: { code: "invalid" } };
        log.error("request failed", {
          method: request.method,
          path: request.url,
          error: error instanceof Error ? (error.stack ?? error.message) : String(error),
        });
        return { status: 500, body: { code: "internal" } };
      })
      .then(({ status, body, html }) => {
        logRequest(request, status, since(started));
        if (html !== undefined) {
          response.writeHead(status, { "content-type": "text/html; charset=utf-8" });
          response.end(html);
          return;
        }
        response.writeHead(status, { "content-type": "application/json" });
        response.end(JSON.stringify(body));
      });
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

async function route(runner: ConversationRunner, request: IncomingMessage): Promise<Reply> {
  const url = new URL(request.url ?? "/", "http://runner");
  const pathname = url.pathname;
  const method = request.method ?? "GET";
  if (pathname === "/health" && method === "GET") return { status: 200, body: { ok: true } };
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
  const ui = UI.exec(pathname);
  if (ui && method === "GET") {
    const transcript = await runner.transcript(ui[1]!);
    if (!transcript) return { status: 404, body: { code: "not_found" } };
    return { status: 200, body: null, html: transcriptPage(transcript, runner.list()) };
  }
  return { status: 404, body: { code: "route_not_found" } };
}

function found(view: ConversationView | undefined): Reply {
  return view ? { status: 200, body: view } : { status: 404, body: { code: "not_found" } };
}

class InvalidRequest extends Error {}

function promptRequest(value: unknown): PromptRequest {
  if (!isObject(value)) throw new InvalidRequest();
  const { prompt, images } = value;
  if (typeof prompt !== "string" || !prompt.trim() || prompt.length > 100_000)
    throw new InvalidRequest();
  if (images === undefined) return { prompt };
  if (!Array.isArray(images) || images.length > 5) throw new InvalidRequest();
  return { prompt, images: images.map(image) };
}

function launchRequest(value: unknown): LaunchRequest {
  const request: LaunchRequest = promptRequest(value);
  const { repository, openPr } = value as Record<string, unknown>;
  if (repository !== undefined) {
    if (typeof repository !== "string" || !URL.canParse(repository)) throw new InvalidRequest();
    if (new URL(repository).protocol !== "https:") throw new InvalidRequest();
    request.repository = repository;
  }
  if (openPr !== undefined) {
    if (typeof openPr !== "boolean") throw new InvalidRequest();
    request.openPr = openPr;
  }
  return request;
}

function image(value: unknown): Image {
  if (isObject(value) && typeof value.url === "string" && URL.canParse(value.url))
    return { url: value.url };
  if (
    isObject(value) &&
    typeof value.data === "string" &&
    typeof value.mimeType === "string" &&
    MIME_TYPES.has(value.mimeType)
  )
    return { data: value.data, mimeType: value.mimeType };
  throw new InvalidRequest();
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) throw new InvalidRequest();
    chunks.push(chunk as Buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new InvalidRequest();
  }
}
