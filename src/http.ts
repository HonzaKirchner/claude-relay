import type { IncomingMessage, ServerResponse } from "node:http";
import type { AgentRunner, AgentView, Image, LaunchRequest, PromptRequest } from "./runner.ts";
import { AgentBusy } from "./runner.ts";

const MAX_BODY_BYTES = 128 * 1024 * 1024;
const MIME_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
const ID = "[A-Za-z0-9_-]{1,128}";
const AGENT = new RegExp(`^/agents/(${ID})$`);
const RUNS = new RegExp(`^/agents/(${ID})/runs$`);
const RUN = new RegExp(`^/agents/(${ID})/runs/(${ID})$`);
const CANCEL = new RegExp(`^/agents/(${ID})/runs/(${ID})/cancel$`);

type Reply = { status: number; body: unknown };

/** JSON API over the runner. Listens on loopback only; Coder's app proxy authenticates callers. */
export function createHandler(runner: AgentRunner) {
  return (request: IncomingMessage, response: ServerResponse) => {
    route(runner, request)
      .catch((error: unknown): Reply => {
        if (error instanceof AgentBusy) return { status: 409, body: { code: "busy" } };
        if (error instanceof InvalidRequest) return { status: 400, body: { code: "invalid" } };
        return { status: 500, body: { code: "internal" } };
      })
      .then(({ status, body }) => {
        response.writeHead(status, { "content-type": "application/json" });
        response.end(JSON.stringify(body));
      });
  };
}

async function route(runner: AgentRunner, request: IncomingMessage): Promise<Reply> {
  const pathname = new URL(request.url ?? "/", "http://runner").pathname;
  const method = request.method ?? "GET";
  if (pathname === "/health" && method === "GET") return { status: 200, body: { ok: true } };
  const agent = AGENT.exec(pathname);
  if (agent && method === "PUT") {
    const body = launchRequest(await readJson(request));
    return found(await runner.launch(agent[1]!, body));
  }
  if (agent && method === "GET") return found(runner.get(agent[1]!));
  const runs = RUNS.exec(pathname);
  if (runs && method === "POST")
    return found(await runner.reply(runs[1]!, promptRequest(await readJson(request))));
  const run = RUN.exec(pathname);
  if (run && method === "GET") return found(runner.get(run[1]!, run[2]!));
  const cancel = CANCEL.exec(pathname);
  if (cancel && method === "POST") return found(await runner.cancel(cancel[1]!, cancel[2]!));
  return { status: 404, body: { code: "route_not_found" } };
}

function found(agent: AgentView | undefined): Reply {
  return agent ? { status: 200, body: agent } : { status: 404, body: { code: "not_found" } };
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
