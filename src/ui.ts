import type { ConversationSummary, Transcript } from "./runner.ts";

type Block = Record<string, unknown>;
type TranscriptRun = Transcript["runs"][number];

/** Caps how much of a single tool result goes into the page. */
const MAX_OUTPUT = 20_000;

/**
 * A self-contained HTML page showing a conversation in the style of the Claude app: prompts as
 * message bubbles, Claude's replies as prose, tool calls as collapsible rows. A sidebar on the
 * left lists every conversation, one on the right sums up this one (status, cost by model, ...).
 * While a run is going, the page fetches itself again and swaps the changing parts in place.
 */
export function transcriptPage(transcript: Transcript, conversations: ConversationSummary[] = []): string {
  const running = transcript.runs.some((run) => run.status === "running");
  const runs = transcript.runs.map((run) => renderRun(run)).join("\n");
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<noscript>${running ? '<meta http-equiv="refresh" content="5">' : ""}</noscript>
<title>${escape(transcript.title)}</title>
<style>${STYLE}</style>
</head>
<body${running ? " data-running" : ""}>
<input type="checkbox" id="toggle-nav" class="toggle" aria-label="Show conversations">
<input type="checkbox" id="toggle-stats" class="toggle" aria-label="Show details">
<div class="layout">
<aside class="sidebar left" aria-label="Conversations">
<div class="sidebar-head"><span class="spark">${ICONS.spark}</span><span>Conversations</span><label for="toggle-nav" class="close" title="Close">${ICONS.x}</label></div>
<nav id="conversations">${conversationList(conversations, transcript.id)}</nav>
</aside>
<div class="center">
<main>
<div id="log">
${runs}
</div>
</main>
</div>
<aside class="sidebar right" aria-label="Conversation details">
<div class="sidebar-head"><span>Details</span><label for="toggle-stats" class="close" title="Close">${ICONS.x}</label></div>
<div id="stats">${statsPanel(transcript)}</div>
</aside>
</div>
<label for="toggle-nav" class="fab nav-button" title="Conversations">${ICONS.menu}</label><label for="toggle-stats" class="fab stats-button" title="Details">${ICONS.panel}</label>
<label class="scrim" for="toggle-nav"></label><label class="scrim stats-scrim" for="toggle-stats"></label>
${running ? `<script>${LIVE_SCRIPT}</script>` : ""}
</body>
</html>`;
}

/**
 * The page behind `/ui/conversations`: the conversation sidebar on its own, no conversation
 * open. `hrefPrefix` makes the links relative to the URL the page was served at, so they keep
 * working behind Coder's app proxy.
 */
export function conversationsPage(conversations: ConversationSummary[], hrefPrefix: string): string {
  const running = conversations.some((conversation) => conversation.status === "running");
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<noscript>${running ? '<meta http-equiv="refresh" content="5">' : ""}</noscript>
<title>Conversations</title>
<style>${STYLE}</style>
</head>
<body${running ? " data-running" : ""}>
<div class="layout index">
<aside class="sidebar left" aria-label="Conversations">
<div class="sidebar-head"><span class="spark">${ICONS.spark}</span><span>Conversations</span></div>
<nav id="conversations">${conversationList(conversations, undefined, hrefPrefix)}</nav>
</aside>
<div class="center">
<main><p class="empty">${conversations.length ? "Select a conversation." : "No conversations yet."}</p></main>
</div>
</div>
${running ? `<script>${LIVE_SCRIPT}</script>` : ""}
</body>
</html>`;
}

function conversationList(conversations: ConversationSummary[], currentId?: string, hrefPrefix = "./"): string {
  if (!conversations.length) return '<p class="empty">No conversations yet.</p>';
  const now = Date.now();
  return `<ul class="conversations">${conversations
    .map((conversation) => {
      const current = conversation.id === currentId;
      const meta = [
        relativeTime(conversation.updatedAt, now),
        `${conversation.runCount} run${conversation.runCount === 1 ? "" : "s"}`,
        conversation.repository ? repoName(conversation.repository) : "",
      ].filter(Boolean);
      return `<li><a href="${hrefPrefix}${encodeURIComponent(conversation.id)}"${current ? ' class="current" aria-current="page"' : ""}><span class="dot ${conversation.status}" title="${conversation.status}"></span><span class="conv-text"><span class="conv-title">${escape(conversation.title)}</span><span class="conv-meta">${escape(meta.join(" · "))}</span></span></a></li>`;
    })
    .join("")}</ul>`;
}

interface ModelUsage {
  cost: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

interface Stats {
  cost: number;
  /** Runs that ended without reporting a cost (still going, killed, crashed). */
  unpriced: number;
  apiMs: number;
  wallMs: number;
  turns: number;
  models: Map<string, ModelUsage>;
  tools: Map<string, number>;
  files: Set<string>;
  runs: Array<{ id: string; seq: number; status: string; cost?: number; ms?: number }>;
}

function computeStats(transcript: Transcript): Stats {
  const stats: Stats = { cost: 0, unpriced: 0, apiMs: 0, wallMs: 0, turns: 0, models: new Map(), tools: new Map(), files: new Set(), runs: [] };
  const model = (name: string) => {
    let usage = stats.models.get(name);
    if (!usage) stats.models.set(name, (usage = { cost: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }));
    return usage;
  };
  for (const run of transcript.runs) {
    let cwd: string | undefined;
    let initModel: string | undefined;
    let cost: number | undefined;
    for (const { event: raw } of run.events) {
      const event = raw as Record<string, unknown>;
      if (event.type === "system" && event.subtype === "init") {
        if (typeof event.cwd === "string") cwd ??= event.cwd;
        if (typeof event.model === "string") initModel ??= event.model;
      }
      if (event.type === "assistant")
        for (const block of blocksOf(event)) {
          if (block.type !== "tool_use") continue;
          const name = String(block.name ?? "tool");
          const mcp = /^mcp__(.+?)__(.+)$/.exec(name);
          const label = mcp ? `${mcp[1]}: ${mcp[2]}` : name;
          stats.tools.set(label, (stats.tools.get(label) ?? 0) + 1);
          const input = (block.input ?? {}) as Record<string, unknown>;
          if (["Edit", "MultiEdit", "Write", "NotebookEdit"].includes(name)) {
            const file = input.file_path ?? input.notebook_path;
            if (typeof file === "string") stats.files.add(relative(file, cwd));
          }
        }
      if (event.type !== "result") continue;
      if (typeof event.total_cost_usd === "number") cost = (cost ?? 0) + event.total_cost_usd;
      if (typeof event.duration_api_ms === "number") stats.apiMs += event.duration_api_ms;
      if (typeof event.num_turns === "number") stats.turns += event.num_turns;
      const usageByModel = event.modelUsage;
      if (usageByModel && typeof usageByModel === "object" && Object.keys(usageByModel).length) {
        for (const [name, value] of Object.entries(usageByModel as Record<string, Record<string, unknown>>)) {
          const usage = model(name);
          usage.cost += number(value.costUSD);
          usage.input += number(value.inputTokens);
          usage.output += number(value.outputTokens);
          usage.cacheRead += number(value.cacheReadInputTokens);
          usage.cacheWrite += number(value.cacheCreationInputTokens);
        }
      } else if (typeof event.total_cost_usd === "number" || event.usage) {
        const usage = model(initModel ?? "unknown model");
        const tokens = (event.usage ?? {}) as Record<string, unknown>;
        usage.cost += number(event.total_cost_usd);
        usage.input += number(tokens.input_tokens);
        usage.output += number(tokens.output_tokens);
        usage.cacheRead += number(tokens.cache_read_input_tokens);
        usage.cacheWrite += number(tokens.cache_creation_input_tokens);
      }
    }
    const started = Date.parse(run.startedAt);
    const ended = run.finishedAt ? Date.parse(run.finishedAt) : run.status === "running" ? Date.now() : NaN;
    const ms = Number.isFinite(started) && Number.isFinite(ended) ? Math.max(0, ended - started) : undefined;
    if (ms !== undefined) stats.wallMs += ms;
    if (cost === undefined) stats.unpriced++;
    else stats.cost += cost;
    stats.runs.push({ id: run.id, seq: run.seq, status: run.status, ...(cost !== undefined ? { cost } : {}), ...(ms !== undefined ? { ms } : {}) });
  }
  return stats;
}

function statsPanel(transcript: Transcript): string {
  const stats = computeStats(transcript);
  const latest = transcript.runs.at(-1);
  const status = latest?.status ?? "unknown";
  const first = transcript.runs[0];
  const tokens = [...stats.models.values()].reduce(
    (sum, usage) => ({ input: sum.input + usage.input, output: sum.output + usage.output, cacheRead: sum.cacheRead + usage.cacheRead, cacheWrite: sum.cacheWrite + usage.cacheWrite }),
    { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  );
  const sections: string[] = [];

  sections.push(`<section class="panel">
  <div class="panel-title">Status</div>
  <div class="status-line"><span class="dot ${status}"></span><span class="status ${status}">${escape(capitalize(status))}</span></div>
  <dl class="facts">
    <dt>Runs</dt><dd>${transcript.runs.length}</dd>
    ${first ? `<dt>Started</dt><dd>${escape(clock(first.startedAt))}</dd>` : ""}
    ${latest ? `<dt>Last activity</dt><dd>${escape(clock(latest.finishedAt ?? latest.startedAt))}</dd>` : ""}
    <dt>Time working</dt><dd>${duration(stats.wallMs)}</dd>
    ${stats.apiMs ? `<dt>Time in API</dt><dd>${duration(stats.apiMs)}</dd>` : ""}
    ${stats.turns ? `<dt>Turns</dt><dd>${stats.turns}</dd>` : ""}
  </dl>
</section>`);

  if (transcript.repository || transcript.branch || transcript.prUrl)
    sections.push(`<section class="panel">
  <div class="panel-title">Repository</div>
  <ul class="links">
    ${transcript.repository ? `<li>${ICONS.repo}${link(transcript.repository, repoName(transcript.repository))}</li>` : ""}
    ${transcript.branch ? `<li>${ICONS.branch}<code>${escape(transcript.branch)}</code>${transcript.pushed ? "" : '<span class="hint">not pushed</span>'}</li>` : ""}
    ${transcript.prUrl ? `<li>${ICONS.pr}${link(transcript.prUrl, prName(transcript.prUrl))}</li>` : ""}
  </ul>
</section>`);

  const models = [...stats.models.entries()].sort((a, b) => b[1].cost - a[1].cost);
  const modelRows = models
    .map(([name, usage]) => {
      const share = stats.cost > 0 ? Math.round((usage.cost / stats.cost) * 100) : 0;
      return `<li class="model">
  <div class="model-head"><span class="model-name" title="${escape(name)}">${escape(modelName(name))}</span><span class="money">${money(usage.cost)}</span></div>
  <div class="meter" role="img" aria-label="${share}% of the cost"><span style="width:${share}%"></span></div>
  <div class="model-tokens">${tokenCount(usage.input)} in · ${tokenCount(usage.output)} out${usage.cacheRead || usage.cacheWrite ? ` · ${tokenCount(usage.cacheRead)} cache read · ${tokenCount(usage.cacheWrite)} cache write` : ""}</div>
</li>`;
    })
    .join("");
  sections.push(`<section class="panel">
  <div class="panel-title">Cost</div>
  <div class="total">${money(stats.cost)}</div>
  ${stats.unpriced ? `<div class="hint">${stats.unpriced} run${stats.unpriced === 1 ? "" : "s"} ${status === "running" && stats.unpriced === 1 ? "still going, not counted yet" : "without a reported cost"}</div>` : ""}
  ${models.length ? `<div class="sub-title">By model</div><ul class="models">${modelRows}</ul>` : '<div class="hint">No usage reported yet.</div>'}
  ${models.length ? `<dl class="facts tokens"><dt>Input tokens</dt><dd>${tokenCount(tokens.input)}</dd><dt>Output tokens</dt><dd>${tokenCount(tokens.output)}</dd><dt>Cache read</dt><dd>${tokenCount(tokens.cacheRead)}</dd><dt>Cache write</dt><dd>${tokenCount(tokens.cacheWrite)}</dd></dl>` : ""}
</section>`);

  sections.push(`<section class="panel">
  <div class="panel-title">Runs</div>
  <ol class="run-list">${stats.runs
    .map((run) => `<li><a href="#run-${escape(run.id)}"><span class="dot ${run.status}"></span><span>Run ${run.seq}</span><span class="run-meta">${[run.ms !== undefined ? duration(run.ms) : "", run.cost !== undefined ? money(run.cost) : ""].filter(Boolean).join(" · ")}</span></a></li>`)
    .join("")}</ol>
</section>`);

  const tools = [...stats.tools.entries()].sort((a, b) => b[1] - a[1]);
  if (tools.length) {
    const max = tools[0]![1];
    sections.push(`<section class="panel">
  <div class="panel-title">Tool calls <span class="count">${tools.reduce((sum, [, count]) => sum + count, 0)}</span></div>
  <ul class="bars">${tools
    .map(([name, count]) => `<li><span class="bar-label" title="${escape(name)}">${escape(name)}</span><span class="bar-track"><span style="width:${Math.max(4, Math.round((count / max) * 100))}%"></span></span><span class="bar-value">${count}</span></li>`)
    .join("")}</ul>
</section>`);
  }

  if (stats.files.size) {
    const files = [...stats.files].sort();
    sections.push(`<section class="panel">
  <div class="panel-title">Files changed <span class="count">${files.length}</span></div>
  <ul class="files">${files.map((file) => `<li title="${escape(file)}">${ICONS.file}<span>${escape(file)}</span></li>`).join("")}</ul>
</section>`);
  }
  return sections.join("\n");
}

function link(url: string, text: string): string {
  return /^https?:\/\//.test(url)
    ? `<a href="${escape(url)}" target="_blank" rel="noopener">${escape(text)}</a>`
    : `<span>${escape(text)}</span>`;
}

function number(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function money(usd: number): string {
  if (usd === 0) return "$0.00";
  return usd < 0.01 ? "<$0.01" : `$${usd.toFixed(2)}`;
}

function tokenCount(count: number): string {
  if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(1)}M`;
  if (count >= 1_000) return `${(count / 1_000).toFixed(1)}k`;
  return String(count);
}

/** `claude-opus-5-5-20261001` → `Opus 5.5`; unknown names are shown as they are. */
function modelName(id: string): string {
  const match = /^claude-([a-z]+)-(\d+)(?:-(\d{1,2}))?(?:-\d{8})?(\[1m\])?$/.exec(id);
  if (!match) return id;
  return `${capitalize(match[1]!)} ${match[2]}${match[3] ? `.${match[3]}` : ""}${match[4] ? " (1M)" : ""}`;
}

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function relativeTime(iso: string, now: number): string {
  const then = Date.parse(iso);
  if (!Number.isFinite(then)) return "";
  const seconds = Math.max(0, Math.round((now - then) / 1000));
  if (seconds < 60) return "just now";
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)}h ago`;
  if (seconds < 7 * 86_400) return `${Math.floor(seconds / 86_400)}d ago`;
  return new Date(then).toISOString().slice(0, 10);
}

function renderRun(run: TranscriptRun): string {
  const results = new Map<string, Block>();
  const children = new Map<string, StoredEventLike[]>();
  let cwd: string | undefined;
  for (const stored of run.events) {
    const event = stored.event as Record<string, unknown>;
    if (event.type === "system" && event.subtype === "init" && typeof event.cwd === "string") cwd ??= event.cwd;
    for (const block of blocksOf(event))
      if (block.type === "tool_result" && typeof block.tool_use_id === "string") results.set(block.tool_use_id, block);
    const parent = event.parent_tool_use_id;
    if (typeof parent === "string") children.set(parent, [...(children.get(parent) ?? []), stored]);
  }
  const context: Context = { results, children, cwd, running: run.status === "running" };
  const top = run.events.filter(({ event }) => typeof (event as Record<string, unknown>).parent_tool_use_id !== "string");
  const images = run.imageCount
    ? `<div class="attachments">${Array.from({ length: run.imageCount }, (_, i) => `<span class="attachment">${ICONS.image}Image ${i + 1}</span>`).join("")}</div>`
    : "";
  const time = run.startedAt ? clock(run.startedAt) : "";
  const label = `<div class="run-label">Run ${run.seq} · <span class="status ${run.status}">${run.status}</span>${time ? ` · <time datetime="${escape(run.startedAt)}">${escape(time)}</time>` : ""}</div>`;
  const footer: string[] = [];
  if (run.status === "running")
    footer.push(`<div class="working"><span class="spark spin">${ICONS.spark}</span><span class="shimmer">Working…</span></div>`);
  if (run.status === "cancelled") footer.push(`<div class="notice">${ICONS.stop}Stopped by user</div>`);
  if (run.error)
    footer.push(`<div class="error-card"><div class="error-title">${ICONS.alert}Something went wrong</div><pre>${escape(cap(run.error))}</pre></div>`);
  if (run.stderr && run.status === "failed")
    footer.push(`<details class="tool" id="${escape(run.id)}-stderr"><summary>${ICONS.terminal}<span class="verb">Claude Code stderr</span>${ICONS.chevron}</summary><div class="tool-card"><pre class="output">${escape(cap(run.stderr))}</pre></div></details>`);
  return `<section class="run" id="run-${escape(run.id)}">
${label}
<div class="user-msg"><div class="bubble">${run.prompt !== undefined ? `<div class="prompt">${escape(run.prompt)}</div>` : ""}${images}</div></div>
<div class="assistant">
${renderEvents(top, context, run.id)}
${footer.join("\n")}
</div>
</section>`;
}

interface StoredEventLike {
  event: unknown;
}

interface Context {
  results: Map<string, Block>;
  children: Map<string, StoredEventLike[]>;
  cwd: string | undefined;
  running: boolean;
}

function renderEvents(events: StoredEventLike[], context: Context, idPrefix: string): string {
  return events
    .map(({ event }, index) => renderEvent(event as Record<string, unknown>, context, `${idPrefix}-${index}`))
    .join("");
}

function renderEvent(event: Record<string, unknown>, context: Context, id: string): string {
  switch (event.type) {
    case "assistant":
      return blocksOf(event)
        .map((block, index) => {
          if (block.type === "text" && String(block.text ?? "").trim())
            return `<div class="prose">${markdown(String(block.text))}</div>`;
          if (block.type === "thinking" && String(block.thinking ?? "").trim())
            return `<details class="thinking" id="${escape(`${id}-${index}`)}"><summary><span>Thought process</span>${ICONS.chevron}</summary><div class="thinking-body">${escape(String(block.thinking))}</div></details>`;
          if (block.type === "tool_use") return renderTool(block, context);
          return "";
        })
        .join("");
    case "result": {
      const parts = [
        typeof event.duration_ms === "number" ? `Worked for ${duration(event.duration_ms)}` : "",
        typeof event.num_turns === "number" ? `${event.num_turns} turn${event.num_turns === 1 ? "" : "s"}` : "",
        typeof event.total_cost_usd === "number" ? `$${event.total_cost_usd.toFixed(2)}` : "",
        typeof event.subtype === "string" && event.subtype !== "success" ? event.subtype.replace(/_/g, " ") : "",
      ].filter(Boolean);
      if (!parts.length) parts.push(event.is_error ? "Failed" : "Done");
      return `<div class="result-meta${event.is_error ? " is-error" : ""}" data-subtype="${escape(String(event.subtype ?? ""))}">${event.is_error ? ICONS.alert : ICONS.check}<span>${escape(parts.join(" · "))}</span></div>`;
    }
    default:
      return "";
  }
}

function renderTool(block: Block, context: Context): string {
  const toolId = String(block.id ?? "");
  const name = String(block.name ?? "tool");
  const input = (block.input ?? {}) as Record<string, unknown>;
  const result = context.results.get(toolId);
  const failed = result?.is_error === true;
  const text = result ? resultText(result.content) : "";
  const label = toolLabel(name, input, context.cwd);
  const state = !result ? (context.running ? "pending" : "missing") : failed ? "failed" : "done";
  const stateIcon = state === "pending" ? '<span class="dots"><i></i><i></i><i></i></span>' : state === "failed" ? `<span class="state-err">${ICONS.alert}</span>` : "";
  const nested = context.children.get(toolId);
  const sub = nested?.length
    ? `<div class="subagent">${renderEvents(nested, context, `${toolId}-sub`)}</div>`
    : "";
  let body: string;
  if (state === "pending") body = '<div class="muted">Running…</div>';
  else if (state === "missing") body = '<div class="muted">No result was recorded.</div>';
  else if (failed) body = `<pre class="output err">${escape(cap(text)) || "Error"}</pre>`;
  else body = toolBody(name, input, text);
  return `<details class="tool ${state}" id="${escape(`tool-${toolId}`)}"><summary>${label.icon}<span class="verb">${escape(label.verb)}</span>${label.target ? `<code class="target">${escape(label.target)}</code>` : ""}${label.extra ?? ""}${stateIcon}${ICONS.chevron}</summary><div class="tool-card">${toolInput(name, input)}${sub}${body}</div></details>`;
}

interface ToolLabel {
  icon: string;
  verb: string;
  target?: string;
  extra?: string;
}

function toolLabel(name: string, input: Record<string, unknown>, cwd: string | undefined): ToolLabel {
  const str = (key: string) => (typeof input[key] === "string" ? (input[key] as string) : undefined);
  const path = (key = "file_path") => relative(str(key) ?? str("notebook_path") ?? "", cwd);
  switch (name) {
    case "Bash":
      return { icon: ICONS.terminal, verb: str("description") ? str("description")! : "Ran", target: str("description") ? undefined : oneLine(str("command") ?? "") };
    case "Read":
      return { icon: ICONS.file, verb: "Read", target: path() };
    case "Edit":
    case "MultiEdit": {
      const edits = name === "Edit" ? [{ old: str("old_string") ?? "", new: str("new_string") ?? "" }] : multiEdits(input);
      const { added, removed } = diffCounts(edits);
      return { icon: ICONS.pencil, verb: "Edited", target: path(), extra: `<span class="counts"><span class="plus">+${added}</span><span class="minus">-${removed}</span></span>` };
    }
    case "Write": {
      const lines = lineCount(str("content") ?? "");
      return { icon: ICONS.filePlus, verb: "Wrote", target: path(), extra: `<span class="counts"><span class="plus">+${lines}</span></span>` };
    }
    case "NotebookEdit":
      return { icon: ICONS.pencil, verb: "Edited notebook", target: path() };
    case "Grep":
      return { icon: ICONS.search, verb: "Searched for", target: str("pattern") ?? "" };
    case "Glob":
      return { icon: ICONS.search, verb: "Found files", target: str("pattern") ?? "" };
    case "LS":
      return { icon: ICONS.folder, verb: "Listed", target: path("path") };
    case "WebFetch":
      return { icon: ICONS.globe, verb: "Fetched", target: str("url") ?? "" };
    case "WebSearch":
      return { icon: ICONS.globe, verb: "Searched the web for", target: str("query") ?? "" };
    case "Task":
    case "Agent":
      return { icon: ICONS.bot, verb: str("description") ?? "Ran a subagent", target: str("subagent_type") };
    case "TodoWrite": {
      const todos = Array.isArray(input.todos) ? (input.todos as Block[]) : [];
      const done = todos.filter((todo) => todo.status === "completed").length;
      return { icon: ICONS.list, verb: "Updated to-dos", extra: `<span class="muted small">${done}/${todos.length} done</span>` };
    }
  }
  const mcp = /^mcp__(.+?)__(.+)$/.exec(name);
  if (mcp) return { icon: ICONS.plug, verb: humanize(mcp[2]!), extra: `<span class="muted small">${escape(mcp[1]!)}</span>` };
  return { icon: ICONS.tool, verb: name };
}

/** The tool's input, where the summary row does not already say everything. */
function toolInput(name: string, input: Record<string, unknown>): string {
  switch (name) {
    case "Bash":
      return `<pre class="command"><span class="muted">$ </span>${escape(String(input.command ?? ""))}</pre>`;
    case "Read":
    case "Edit":
    case "MultiEdit":
    case "Write":
    case "TodoWrite":
    case "LS":
      return "";
    case "Task":
    case "Agent":
      return typeof input.prompt === "string" ? `<div class="section-label">Prompt</div><div class="subprompt">${escape(input.prompt)}</div>` : "";
  }
  const entries = Object.entries(input);
  if (!entries.length) return "";
  return `<div class="section-label">Input</div><pre class="output">${escape(cap(JSON.stringify(input, null, 2)))}</pre>`;
}

function toolBody(name: string, input: Record<string, unknown>, text: string): string {
  switch (name) {
    case "Edit":
      return diff([{ old: String(input.old_string ?? ""), new: String(input.new_string ?? "") }]);
    case "MultiEdit":
      return diff(multiEdits(input));
    case "Write":
      return `<pre class="output code-view">${escape(cap(String(input.content ?? "")))}</pre>`;
    case "Read":
      return `<pre class="output code-view">${escape(cap(text))}</pre>`;
    case "TodoWrite":
      return todos(input.todos);
    case "Task":
    case "Agent":
      return `<div class="section-label">Result</div><div class="prose small">${markdown(cap(text))}</div>`;
  }
  if (!text.trim()) return '<div class="muted">No output</div>';
  return `${name === "Bash" ? "" : '<div class="section-label">Output</div>'}<pre class="output">${escape(cap(text.replace(/\n+$/, "")))}</pre>`;
}

function multiEdits(input: Record<string, unknown>): Array<{ old: string; new: string }> {
  const edits = Array.isArray(input.edits) ? (input.edits as Block[]) : [];
  return edits.map((edit) => ({ old: String(edit.old_string ?? ""), new: String(edit.new_string ?? "") }));
}

interface Hunk {
  before: string[];
  minus: string[];
  plus: string[];
  after: string[];
}

function hunk(edit: { old: string; new: string }): Hunk {
  const before = edit.old.split("\n");
  const after = edit.new.split("\n");
  let start = 0;
  while (start < before.length && start < after.length && before[start] === after[start]) start++;
  let end = 0;
  while (end < before.length - start && end < after.length - start && before[before.length - 1 - end] === after[after.length - 1 - end]) end++;
  return {
    before: before.slice(0, start),
    minus: before.slice(start, before.length - end),
    plus: after.slice(start, after.length - end),
    after: before.slice(before.length - end),
  };
}

function diffCounts(edits: Array<{ old: string; new: string }>) {
  return edits.map(hunk).reduce((sum, h) => ({ added: sum.added + h.plus.length, removed: sum.removed + h.minus.length }), { added: 0, removed: 0 });
}

function diff(edits: Array<{ old: string; new: string }>): string {
  const line = (cls: string, sign: string, text: string) => `<div class="${cls}"><span class="sign">${sign}</span>${escape(text) || " "}</div>`;
  const hunks = edits.map(hunk).map((h) =>
    [
      ...h.before.map((text) => line("ctx", "", text)),
      ...h.minus.map((text) => line("del", "−", text)),
      ...h.plus.map((text) => line("add", "+", text)),
      ...h.after.map((text) => line("ctx", "", text)),
    ].join(""),
  );
  return `<div class="diff">${hunks.join('<div class="sep">⋯</div>')}</div>`;
}

function todos(value: unknown): string {
  const items = Array.isArray(value) ? (value as Block[]) : [];
  return `<ul class="todos">${items
    .map((todo) => {
      const status = String(todo.status ?? "pending");
      const mark = status === "completed" ? ICONS.checkCircle : status === "in_progress" ? ICONS.halfCircle : ICONS.circle;
      return `<li class="${escape(status)}">${mark}<span>${escape(String(todo.content ?? ""))}</span></li>`;
    })
    .join("")}</ul>`;
}

/** A small, escape-first Markdown renderer: fences, headings, lists, quotes, inline code, bold, italics, links. */
function markdown(text: string): string {
  const parts = text.split(/```([^\n]*)\n([\s\S]*?)(?:```|$)/g);
  let html = "";
  for (let index = 0; index < parts.length; index += 3) {
    html += blocks(parts[index] ?? "");
    if (index + 2 < parts.length) {
      const lang = (parts[index + 1] ?? "").trim();
      html += `<div class="codeblock">${lang ? `<div class="lang">${escape(lang)}</div>` : ""}<pre><code>${escape((parts[index + 2] ?? "").replace(/\n$/, ""))}</code></pre></div>`;
    }
  }
  return html;
}

function blocks(text: string): string {
  const out: string[] = [];
  let list: { tag: "ul" | "ol"; items: string[] } | undefined;
  let paragraph: string[] = [];
  const flush = () => {
    if (paragraph.length) out.push(`<p>${paragraph.map(inline).join("<br>")}</p>`);
    paragraph = [];
    if (list) out.push(`<${list.tag}>${list.items.map((item) => `<li>${item}</li>`).join("")}</${list.tag}>`);
    list = undefined;
  };
  for (const line of text.split("\n")) {
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    const bullet = /^\s*[-*+]\s+(.*)$/.exec(line);
    const numbered = /^\s*\d+[.)]\s+(.*)$/.exec(line);
    const quote = /^>\s?(.*)$/.exec(line);
    if (!line.trim()) flush();
    else if (heading) {
      flush();
      const level = Math.min(heading[1]!.length + 1, 4);
      out.push(`<h${level}>${inline(heading[2]!)}</h${level}>`);
    } else if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) {
      flush();
      out.push("<hr>");
    } else if (bullet || numbered) {
      const tag = bullet ? "ul" : "ol";
      if (paragraph.length || (list && list.tag !== tag)) flush();
      list ??= { tag, items: [] };
      list.items.push(inline((bullet ?? numbered)![1]!));
    } else if (quote) {
      flush();
      out.push(`<blockquote>${inline(quote[1]!)}</blockquote>`);
    } else if (list && /^\s+/.test(line)) list.items[list.items.length - 1] += ` ${inline(line.trim())}`;
    else {
      if (list) flush();
      paragraph.push(line);
    }
  }
  flush();
  return out.join("");
}

function inline(text: string): string {
  return text
    .split(/(`[^`]+`)/g)
    .map((part) => {
      if (/^`[^`]+`$/.test(part)) return `<code>${escape(part.slice(1, -1))}</code>`;
      return escape(part)
        .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
        .replace(/(^|[^*\w])\*([^*\s][^*]*?)\*(?!\w)/g, "$1<em>$2</em>")
        .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
    })
    .join("");
}

function blocksOf(event: Record<string, unknown>): Block[] {
  const content = (event.message as { content?: unknown } | undefined)?.content;
  return Array.isArray(content) ? (content as Block[]) : [];
}

function resultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content))
    return content.map((part: Block) => (part.type === "text" ? String(part.text ?? "") : `[${String(part.type)}]`)).join("\n");
  if (content === undefined || content === null) return "";
  return JSON.stringify(content, null, 2);
}

function relative(path: string, cwd: string | undefined): string {
  const base = cwd?.replace(/\/$/, "");
  return base && path.startsWith(`${base}/`) ? path.slice(base.length + 1) : path;
}

function repoName(url: string): string {
  return url.replace(/^https?:\/\/[^/]+\//, "").replace(/\.git$/, "");
}

function prName(url: string): string {
  const number = /\/pull\/(\d+)/.exec(url);
  return number ? `PR #${number[1]}` : "Pull request";
}

function humanize(name: string): string {
  const words = name.replace(/[_-]+/g, " ").trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

function lineCount(text: string): number {
  return text ? text.replace(/\n+$/, "").split("\n").length : 0;
}

function oneLine(text: string): string {
  const lines = text.trim().split("\n");
  return lines.length > 1 ? `${lines[0]} …` : (lines[0] ?? "");
}

function cap(text: string): string {
  return text.length > MAX_OUTPUT ? `${text.slice(0, MAX_OUTPUT)}\n… (${text.length - MAX_OUTPUT} more characters not shown)` : text;
}

function duration(ms: number): string {
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  return minutes < 60 ? `${minutes}m ${seconds % 60}s` : `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

function clock(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : `${date.toISOString().replace("T", " ").slice(0, 16)} UTC`;
}

function escape(text: string) {
  return text.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);
}

const svg = (body: string, cls = "icon") =>
  `<svg class="${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;

const ICONS = {
  spark: `<svg viewBox="0 0 24 24" aria-hidden="true"><g fill="currentColor">${Array.from({ length: 8 }, (_, i) => `<rect x="11" y="1.5" width="2" height="9" rx="1" transform="rotate(${i * 45} 12 12)"/>`).join("")}</g></svg>`,
  terminal: svg('<rect x="3" y="4" width="18" height="16" rx="2"/><path d="m7 9 3 3-3 3M13 15h4"/>'),
  file: svg('<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/>'),
  filePlus: svg('<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5M12 11v6M9 14h6"/>'),
  pencil: svg('<path d="M4 20h4L19 9a2.8 2.8 0 0 0-4-4L4 16z"/><path d="m13.5 6.5 4 4"/>'),
  search: svg('<circle cx="11" cy="11" r="7"/><path d="m20 20-4-4"/>'),
  folder: svg('<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>'),
  globe: svg('<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18"/>'),
  bot: svg('<rect x="4" y="8" width="16" height="12" rx="3"/><path d="M12 4v4M9 14h.01M15 14h.01"/>'),
  list: svg('<path d="M9 6h11M9 12h11M9 18h11M4 6h.01M4 12h.01M4 18h.01"/>'),
  plug: svg('<path d="M9 2v6M15 2v6M6 8h12v3a6 6 0 0 1-12 0zM12 17v5"/>'),
  tool: svg('<path d="M14.7 6.3a4 4 0 0 0-5.4 5.4L3 18v3h3l6.3-6.3a4 4 0 0 0 5.4-5.4l-2.6 2.6-2.4-.6-.6-2.4z"/>'),
  chevron: svg('<path d="m9 6 6 6-6 6"/>', "icon chevron"),
  alert: svg('<circle cx="12" cy="12" r="9"/><path d="M12 8v5M12 16h.01"/>'),
  check: svg('<path d="m5 12 5 5 9-10"/>'),
  stop: svg('<rect x="6" y="6" width="12" height="12" rx="2"/>'),
  image: svg('<rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="9" cy="10" r="2"/><path d="m21 16-5-5-9 9"/>'),
  repo: svg('<path d="M5 4a2 2 0 0 1 2-2h12v16H7a2 2 0 0 0-2 2zM5 20a2 2 0 0 0 2 2h12v-4"/>'),
  branch: svg('<circle cx="6" cy="5" r="2"/><circle cx="6" cy="19" r="2"/><circle cx="18" cy="7" r="2"/><path d="M6 7v10M18 9a6 6 0 0 1-6 6H6"/>'),
  pr: svg('<circle cx="6" cy="5" r="2"/><circle cx="6" cy="19" r="2"/><circle cx="18" cy="19" r="2"/><path d="M6 7v10M18 17V9a3 3 0 0 0-3-3h-4m2-2-2 2 2 2"/>'),
  circle: svg('<circle cx="12" cy="12" r="8"/>'),
  halfCircle: svg('<circle cx="12" cy="12" r="8"/><path d="M12 4a8 8 0 0 1 0 16z" fill="currentColor"/>'),
  menu: svg('<path d="M4 7h16M4 12h16M4 17h16"/>'),
  panel: svg('<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M15 4v16"/>'),
  x: svg('<path d="M6 6l12 12M18 6 6 18"/>'),
  checkCircle: svg('<circle cx="12" cy="12" r="8"/><path d="m8.5 12 2.5 2.5 4.5-5"/>'),
};

/** Polls the page while a run is going and swaps the transcript in, keeping scroll and open sections. */
const LIVE_SCRIPT = `
(() => {
  const nearBottom = () => innerHeight + scrollY >= document.documentElement.scrollHeight - 120;
  scrollTo(0, document.documentElement.scrollHeight);
  async function tick() {
    let doc;
    try {
      const response = await fetch(location.href, { cache: "no-store", headers: { accept: "text/html" } });
      if (!response.ok) throw new Error(String(response.status));
      doc = new DOMParser().parseFromString(await response.text(), "text/html");
    } catch {
      return setTimeout(tick, 5000);
    }
    const stick = nearBottom();
    const open = [...document.querySelectorAll("details[open][id]")].map((d) => d.id);
    for (const id of ["log", "conversations", "stats"]) {
      const next = doc.getElementById(id);
      if (next) document.getElementById(id)?.replaceWith(next);
    }
    for (const id of open) document.getElementById(id)?.setAttribute("open", "");
    document.title = doc.title;
    if (stick) scrollTo(0, document.documentElement.scrollHeight);
    if (doc.body.hasAttribute("data-running")) setTimeout(tick, 2000);
    else document.body.removeAttribute("data-running");
  }
  setTimeout(tick, 2000);
})();
`;

const STYLE = `
  :root {
    color-scheme: light;
    --bg: #faf9f5; --surface: #ffffff; --bubble: #f0eee6; --border: #e5e2d9; --border-strong: #d6d2c6;
    --text: #141413; --text-2: #3d3d3a; --muted: #73726c; --accent: #d97757; --accent-soft: rgba(217, 119, 87, .12);
    --ok: #3f7d4e; --err: #b53333; --err-soft: #fbeceb; --code-bg: #f5f4ee; --inline-code: #f0eee6;
    --add-bg: #e6f4e8; --add-fg: #1f5f2d; --del-bg: #fbe9e9; --del-fg: #8f2424; --link: #2c5fb3;
    --sidebar: #f5f4ed; --hover: rgba(20, 20, 19, .05); --selected: rgba(20, 20, 19, .08); --shadow: 0 10px 40px rgba(0, 0, 0, .18);
    --serif: "Copernicus", "Tiempos Text", "Iowan Old Style", "Charter", Georgia, "Times New Roman", serif;
    --sans: "Styrene B", ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
    --mono: ui-monospace, "SF Mono", "JetBrains Mono", Menlo, Consolas, monospace;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      color-scheme: dark;
      --bg: #262624; --surface: #30302e; --bubble: #141413; --border: #3a3a37; --border-strong: #4a4a46;
      --text: #f5f4ef; --text-2: #c2c0b6; --muted: #9c9a92; --accent: #d97757; --accent-soft: rgba(217, 119, 87, .16);
      --ok: #7ec48f; --err: #f08b8b; --err-soft: #3a2422; --code-bg: #1f1e1d; --inline-code: #1f1e1d;
      --sidebar: #1f1e1d; --hover: rgba(255, 255, 255, .05); --selected: rgba(255, 255, 255, .09); --shadow: 0 10px 40px rgba(0, 0, 0, .5);
      --add-bg: #1f3324; --add-fg: #a6dcb2; --del-bg: #3d2223; --del-fg: #f2b0b0; --link: #8db4f5;
    }
  }
  * { box-sizing: border-box; }
  html { background: var(--bg); }
  body { margin: 0; background: var(--bg); color: var(--text); font: 15px/1.6 var(--sans); -webkit-font-smoothing: antialiased; }
  a { color: var(--link); text-decoration: none; } a:hover { text-decoration: underline; }
  .icon { width: 16px; height: 16px; flex: none; }
  .muted { color: var(--muted); } .small { font-size: 13px; }

  .layout { display: grid; grid-template-columns: 320px minmax(0, 1fr) 360px; min-height: 100vh; }
  .layout.index { grid-template-columns: 320px minmax(0, 1fr); }
  .center { min-width: 0; }
  .toggle { position: absolute; opacity: 0; pointer-events: none; }
  .sidebar { position: sticky; top: 0; height: 100vh; overflow-y: auto; background: var(--sidebar); font-size: 14px; display: flex; flex-direction: column; }
  .sidebar.left { border-right: 1px solid var(--border); }
  .sidebar.right { border-left: 1px solid var(--border); }
  .sidebar-head { position: sticky; top: 0; z-index: 1; display: flex; align-items: center; gap: 8px; padding: 14px 16px 10px; font-weight: 600; background: var(--sidebar); }
  .sidebar-head .close { margin-left: auto; display: none; cursor: pointer; color: var(--muted); }
  .empty, .hint { color: var(--muted); font-size: 13px; }
  .empty { padding: 0 16px; }

  .conversations { list-style: none; margin: 0; padding: 0 8px 16px; display: flex; flex-direction: column; gap: 1px; }
  .conversations a { display: flex; gap: 10px; align-items: flex-start; padding: 7px 10px; border-radius: 8px; color: var(--text-2); }
  .conversations a:hover { background: var(--hover); text-decoration: none; }
  .conversations a.current { background: var(--selected); color: var(--text); }
  .conversations .dot { margin-top: 7px; }
  .conv-text { display: flex; flex-direction: column; min-width: 0; }
  .conv-title { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .conv-meta { font-size: 12px; color: var(--muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .dot { width: 8px; height: 8px; border-radius: 50%; flex: none; display: inline-block; background: var(--muted); }
  .dot.running { background: var(--accent); box-shadow: 0 0 0 3px var(--accent-soft); animation: pulse 1.6s ease-in-out infinite; }
  .dot.finished { background: var(--ok); } .dot.failed { background: var(--err); } .dot.cancelled { background: var(--muted); }
  @keyframes pulse { 50% { box-shadow: 0 0 0 5px transparent; } }

  #stats { padding: 0 16px 24px; display: flex; flex-direction: column; gap: 14px; }
  .panel { background: var(--surface); border: 1px solid var(--border); border-radius: 12px; padding: 12px 14px; }
  .panel-title { font-size: 12px; font-weight: 600; letter-spacing: .04em; text-transform: uppercase; color: var(--muted); margin-bottom: 8px; display: flex; align-items: center; gap: 6px; }
  .panel-title .count { font-weight: 500; letter-spacing: 0; background: var(--hover); border-radius: 999px; padding: 0 7px; color: var(--text-2); }
  .sub-title { font-size: 12px; color: var(--muted); margin: 12px 0 6px; }
  .status-line { display: flex; align-items: center; gap: 8px; font-size: 16px; font-weight: 600; margin-bottom: 8px; }
  .facts { display: grid; grid-template-columns: auto 1fr; gap: 4px 12px; margin: 0; font-size: 13px; }
  .facts dt { color: var(--muted); } .facts dd { margin: 0; text-align: right; font-variant-numeric: tabular-nums; }
  .facts.tokens { margin-top: 12px; padding-top: 10px; border-top: 1px solid var(--border); }
  .total { font: 600 26px/1.2 var(--serif); font-variant-numeric: tabular-nums; }
  .models { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 10px; }
  .model-head { display: flex; justify-content: space-between; gap: 8px; font-size: 13.5px; }
  .model-name { font-weight: 500; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .money { font-variant-numeric: tabular-nums; }
  .meter, .bar-track { display: block; height: 6px; border-radius: 999px; background: var(--hover); overflow: hidden; margin: 5px 0 4px; }
  .meter span, .bar-track span { display: block; height: 100%; border-radius: inherit; background: var(--accent); }
  .model-tokens { font-size: 12px; color: var(--muted); }
  .run-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 2px; font-size: 13px; }
  .run-list a { display: flex; align-items: center; gap: 8px; padding: 4px 6px; margin: 0 -6px; border-radius: 6px; color: var(--text-2); }
  .run-list a:hover { background: var(--hover); text-decoration: none; }
  .run-meta { margin-left: auto; color: var(--muted); font-variant-numeric: tabular-nums; }
  .bars { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 6px; font-size: 13px; }
  .bars li { display: grid; grid-template-columns: minmax(0, 1fr) 70px 2.5em; align-items: center; gap: 8px; }
  .bars .bar-track { margin: 0; }
  .bar-label { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--text-2); }
  .bar-value { text-align: right; font-variant-numeric: tabular-nums; color: var(--muted); }
  .files { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 4px; font: 12px var(--mono); }
  .files li { display: flex; align-items: center; gap: 6px; color: var(--text-2); min-width: 0; }
  .files li span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; direction: rtl; text-align: left; }
  .files .icon { width: 13px; height: 13px; color: var(--muted); }

  .fab { display: none; position: fixed; top: 12px; z-index: 5; cursor: pointer; color: var(--text-2); background: var(--surface); border: 1px solid var(--border); border-radius: 10px; padding: 7px; box-shadow: 0 2px 8px rgba(0, 0, 0, .08); }
  .fab:hover { color: var(--text); border-color: var(--border-strong); }
  .fab .icon { width: 18px; height: 18px; display: block; }
  .fab.nav-button { left: 12px; } .fab.stats-button { right: 12px; }
  .links { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 6px; font-size: 13.5px; }
  .links li { display: flex; align-items: center; gap: 8px; min-width: 0; }
  .links li > :not(.icon) { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .links .icon { width: 14px; height: 14px; color: var(--muted); }
  .links code { font: 12.5px var(--mono); }
  .links .hint { flex: none; }
  .scrim { display: none; }
  @media (max-width: 1380px) {
    .layout { grid-template-columns: 320px minmax(0, 1fr); }
    .sidebar.right { position: fixed; right: 0; top: 0; width: min(380px, 92vw); z-index: 10; transform: translateX(100%); transition: transform .2s ease; box-shadow: var(--shadow); }
    #toggle-stats:checked ~ .layout .sidebar.right { transform: none; }
    #toggle-stats:checked ~ .stats-scrim { display: block; }
    .stats-button, .sidebar.right .close { display: inline-flex; }
  }
  @media (max-width: 1000px) {
    .layout { grid-template-columns: minmax(0, 1fr); }
    .sidebar.left { position: fixed; left: 0; top: 0; width: min(340px, 92vw); z-index: 10; transform: translateX(-100%); transition: transform .2s ease; box-shadow: var(--shadow); }
    #toggle-nav:checked ~ .layout .sidebar.left { transform: none; }
    #toggle-nav:checked ~ .scrim:not(.stats-scrim) { display: block; }
    .nav-button, .sidebar.left .close { display: inline-flex; }
    /* With no conversation open, the list is the page. */
    .layout.index { grid-template-columns: minmax(0, 1fr); }
    .layout.index .sidebar.left { position: static; width: auto; height: auto; min-height: 100vh; transform: none; box-shadow: none; border-right: 0; }
    .layout.index .center { display: none; }
  }
  .scrim { position: fixed; inset: 0; z-index: 9; background: rgba(0, 0, 0, .3); }
  @media (prefers-reduced-motion: reduce) { .dot.running { animation: none; } .sidebar { transition: none !important; } }

  .spark { color: var(--accent); display: inline-flex; width: 20px; height: 20px; flex: none; }
  .spark svg { width: 100%; height: 100%; }

  main { max-width: 768px; margin: 0 auto; padding: 24px 16px 96px; }
  .run { padding-top: 20px; }
  .run-label { text-align: center; font-size: 12px; color: var(--muted); margin: 8px 0 16px; }
  .status.running { color: var(--accent); } .status.finished { color: var(--ok); } .status.failed, .status.cancelled { color: var(--err); }

  .user-msg { display: flex; justify-content: flex-end; margin-bottom: 20px; }
  .bubble { background: var(--bubble); border-radius: 16px; padding: 10px 16px; max-width: min(85%, 600px); }
  .prompt { white-space: pre-wrap; overflow-wrap: anywhere; }
  .attachments { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 8px; }
  .attachment { display: inline-flex; align-items: center; gap: 5px; font-size: 12.5px; color: var(--text-2); background: var(--surface); border: 1px solid var(--border); border-radius: 8px; padding: 3px 8px; }

  .assistant { display: flex; flex-direction: column; gap: 6px; }
  .prose { font: 16.5px/1.65 var(--serif); color: var(--text); overflow-wrap: anywhere; margin: 4px 0 8px; }
  .prose.small { font-size: 15px; }
  .prose p { margin: 0 0 .8em; } .prose > :last-child { margin-bottom: 0; }
  .prose h2, .prose h3, .prose h4 { font-family: var(--serif); font-weight: 600; margin: 1.1em 0 .4em; line-height: 1.3; }
  .prose h2 { font-size: 1.3em; } .prose h3 { font-size: 1.15em; } .prose h4 { font-size: 1em; }
  .prose ul, .prose ol { margin: 0 0 .8em; padding-left: 1.6em; } .prose li { margin: .2em 0; }
  .prose blockquote { margin: 0 0 .8em; padding-left: 1em; border-left: 3px solid var(--border-strong); color: var(--text-2); }
  .prose hr { border: 0; border-top: 1px solid var(--border); margin: 1.2em 0; }
  .prose code { font: .86em var(--mono); background: var(--inline-code); border: 1px solid var(--border); border-radius: 5px; padding: .1em .35em; }
  .codeblock { background: var(--code-bg); border: 1px solid var(--border); border-radius: 10px; margin: .4em 0 1em; overflow: hidden; }
  .codeblock .lang { font: 12px var(--sans); color: var(--muted); padding: 6px 14px; border-bottom: 1px solid var(--border); }
  .codeblock pre { margin: 0; padding: 12px 14px; overflow-x: auto; font: 13px/1.55 var(--mono); }
  .codeblock code { background: none; border: 0; padding: 0; font: inherit; }

  details > summary { list-style: none; cursor: pointer; }
  details > summary::-webkit-details-marker { display: none; }
  .chevron { width: 14px; height: 14px; color: var(--muted); transition: transform .15s ease; }
  details[open] > summary .chevron { transform: rotate(90deg); }

  .thinking > summary { display: inline-flex; align-items: center; gap: 4px; font-size: 14px; color: var(--muted); padding: 2px 0; }
  .thinking > summary:hover { color: var(--text-2); }
  .thinking-body { margin: 6px 0 8px; padding: 2px 0 2px 14px; border-left: 2px solid var(--border); color: var(--muted); font-size: 14px; white-space: pre-wrap; overflow-wrap: anywhere; }

  .tool > summary { display: flex; align-items: center; gap: 8px; padding: 5px 10px; margin: 0 -10px; border-radius: 8px; color: var(--text-2); font-size: 14px; min-width: 0; }
  .tool > summary:hover { background: var(--accent-soft); }
  .tool > summary > .icon:first-child { color: var(--muted); }
  .tool .verb { flex: none; max-width: 60%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .tool .target { font: 12.5px var(--mono); color: var(--text); background: var(--inline-code); border: 1px solid var(--border); border-radius: 5px; padding: 1px 6px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; }
  .tool .chevron { margin-left: auto; }
  .tool.failed > summary .verb { color: var(--err); }
  .state-err { color: var(--err); display: inline-flex; }
  .counts { font: 12px var(--mono); display: inline-flex; gap: 6px; } .plus { color: var(--ok); } .minus { color: var(--err); }
  .dots { display: inline-flex; gap: 3px; } .dots i { width: 4px; height: 4px; border-radius: 50%; background: var(--accent); animation: dot 1.2s infinite ease-in-out; }
  .dots i:nth-child(2) { animation-delay: .15s; } .dots i:nth-child(3) { animation-delay: .3s; }
  @keyframes dot { 0%, 80%, 100% { opacity: .25; } 40% { opacity: 1; } }

  .tool-card { margin: 4px 0 10px 24px; background: var(--surface); border: 1px solid var(--border); border-radius: 10px; padding: 10px 12px; display: flex; flex-direction: column; gap: 8px; min-width: 0; }
  .section-label { font-size: 11.5px; font-weight: 600; letter-spacing: .04em; text-transform: uppercase; color: var(--muted); }
  pre.command, pre.output { margin: 0; font: 12.5px/1.55 var(--mono); white-space: pre-wrap; overflow-wrap: anywhere; max-height: 420px; overflow: auto; }
  pre.command { color: var(--text); }
  pre.output { background: var(--code-bg); border-radius: 6px; padding: 8px 10px; color: var(--text-2); }
  pre.output.err { color: var(--err); background: var(--err-soft); }
  pre.code-view { white-space: pre; }
  .subprompt { font-size: 13.5px; color: var(--text-2); white-space: pre-wrap; max-height: 200px; overflow: auto; }
  .subagent { border-left: 2px solid var(--border); padding-left: 12px; display: flex; flex-direction: column; gap: 4px; }

  .diff { font: 12.5px/1.55 var(--mono); border: 1px solid var(--border); border-radius: 6px; overflow: auto; max-height: 480px; background: var(--code-bg); }
  .diff > div { white-space: pre; padding-right: 10px; min-width: max-content; }
  .diff .sign { display: inline-block; width: 2.2em; text-align: center; user-select: none; color: var(--muted); }
  .diff .add { background: var(--add-bg); color: var(--add-fg); } .diff .add .sign { color: var(--add-fg); }
  .diff .del { background: var(--del-bg); color: var(--del-fg); } .diff .del .sign { color: var(--del-fg); }
  .diff .ctx { color: var(--muted); }
  .diff .sep { color: var(--muted); text-align: center; border-block: 1px dashed var(--border); }

  .todos { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 4px; font-size: 14px; }
  .todos li { display: flex; align-items: center; gap: 8px; }
  .todos .completed { color: var(--muted); } .todos .completed span { text-decoration: line-through; }
  .todos .completed .icon { color: var(--ok); } .todos .in_progress { font-weight: 600; } .todos .in_progress .icon { color: var(--accent); }
  .todos .pending .icon { color: var(--muted); }

  .result-meta { display: inline-flex; align-items: center; gap: 6px; font-size: 12.5px; color: var(--muted); margin-top: 6px; }
  .result-meta .icon { width: 14px; height: 14px; color: var(--ok); }
  .result-meta.is-error, .result-meta.is-error .icon { color: var(--err); }
  .notice { display: inline-flex; align-items: center; gap: 6px; font-size: 13.5px; color: var(--muted); margin-top: 6px; }
  .error-card { border: 1px solid color-mix(in srgb, var(--err) 35%, transparent); background: var(--err-soft); border-radius: 10px; padding: 10px 12px; margin-top: 6px; }
  .error-title { display: flex; align-items: center; gap: 6px; color: var(--err); font-weight: 600; font-size: 14px; }
  .error-card pre { margin: 6px 0 0; font: 12.5px/1.5 var(--mono); white-space: pre-wrap; overflow-wrap: anywhere; color: var(--text-2); max-height: 300px; overflow: auto; }

  .working { display: flex; align-items: center; gap: 10px; margin-top: 10px; font-size: 14px; color: var(--muted); }
  .spark.spin svg { animation: spin 2.4s linear infinite; }
  @keyframes spin { to { transform: rotate(360deg); } }
  .shimmer { background: linear-gradient(90deg, var(--muted) 30%, var(--text) 50%, var(--muted) 70%); background-size: 200% 100%; -webkit-background-clip: text; background-clip: text; color: transparent; animation: shimmer 2s linear infinite; }
  @keyframes shimmer { from { background-position: 100% 0; } to { background-position: -100% 0; } }
  @media (prefers-reduced-motion: reduce) { .spark.spin svg, .shimmer, .dots i { animation: none; } .shimmer { color: var(--muted); } }

  @media (max-width: 1380px) { main { padding-top: 56px; } }
  @media (max-width: 560px) {
    .bubble { max-width: 92%; }
    .tool-card { margin-left: 0; }
    .prose { font-size: 16px; }
  }
`;
