// One-time import of conversations stored by older versions of the service, which kept
// them in files under RUNNER_DATA_DIR (`agents/<id>.json`, `logs/<id>/<run>.jsonl`), into
// the database at DB_CONNECTION_STRING. The service itself reads and writes only the database.
//
//   npm run db:import      (loads .env if present)
//
// Conversations already in the database are skipped, so running it again is safe. The
// files are only read, never changed; delete `agents/` and `logs/` once you are satisfied.
// Imported events carry their run's start time: the files did not record when each arrived.

import { readdir, readFile, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { ClaudeEvent, Conversation, Run, RunStatus } from "../src/db.ts";
import { Store } from "../src/db.ts";

interface FileRun {
  id: string;
  status: RunStatus;
  error?: string;
  prompt?: string;
  imageCount?: number;
  startedAt?: string;
  finishedAt?: string;
}

type FileConversation = Omit<Conversation, "runs"> & { runs: FileRun[] };

const connectionString = process.env.DB_CONNECTION_STRING;
if (!connectionString) {
  console.error("DB_CONNECTION_STRING is not set (add it to .env or the environment).");
  process.exit(1);
}
const dataDir = process.env.RUNNER_DATA_DIR || path.join(os.homedir(), ".claude-code-runner");
const recordsDir = path.join(dataDir, "agents");

const store = new Store(connectionString);
let imported = 0;
let skipped = 0;
try {
  await store.migrate();
  const known = new Set((await store.loadConversations()).map((conversation) => conversation.id));
  const files = (await readdir(recordsDir).catch(() => [])).filter((name) => name.endsWith(".json"));
  for (const name of files.sort()) {
    const file = path.join(recordsDir, name);
    const record = JSON.parse(await readFile(file, "utf8")) as FileConversation;
    if (known.has(record.id)) {
      skipped += 1;
      continue;
    }
    // Fallback for runs saved before their times were recorded.
    const fileTime = (await stat(file)).mtime.toISOString();
    const runs: Run[] = record.runs.map((run) => ({
      id: run.id,
      // A run still "running" in the files was cut off when the old service stopped.
      status: run.status === "running" ? "failed" : run.status,
      prompt: run.prompt ?? "",
      ...(run.imageCount ? { imageCount: run.imageCount } : {}),
      ...(run.status === "running"
        ? { error: "The runner restarted during this run." }
        : run.error
          ? { error: run.error }
          : {}),
      startedAt: run.startedAt ?? run.finishedAt ?? fileTime,
      ...(run.finishedAt ? { finishedAt: run.finishedAt } : {}),
    }));
    const conversation: Conversation = { ...record, runs };
    await store.saveConversation(conversation);
    for (const [index, run] of runs.entries()) {
      const { events, stderr } = await readLog(record.id, run.id);
      if (stderr) run.stderr = stderr;
      await store.saveRun(record.id, index + 1, run);
      events.forEach((event, position) =>
        store.saveEvent(record.id, run.id, position + 1, new Date(run.startedAt), event),
      );
    }
    await store.flush();
    imported += 1;
    console.log(`imported ${record.id} (${runs.length} run${runs.length === 1 ? "" : "s"})`);
  }
  console.log(`Done: ${imported} imported, ${skipped} already in the database.`);
} catch (error) {
  console.error("Import failed:", error instanceof Error ? error.message : error);
  process.exitCode = 1;
} finally {
  await store.close();
}

/** A run's log held Claude's stdout (JSON events) and stderr (anything else) interleaved. */
async function readLog(conversationId: string, runId: string) {
  const content = await readFile(path.join(dataDir, "logs", conversationId, `${runId}.jsonl`), "utf8").catch(
    () => "",
  );
  const events: ClaudeEvent[] = [];
  const stderr: string[] = [];
  for (const line of content.split("\n")) {
    if (!line.trim()) continue;
    try {
      const value: unknown = JSON.parse(line);
      if (value && typeof value === "object" && !Array.isArray(value)) {
        events.push(value as ClaudeEvent);
        continue;
      }
    } catch {
      // Not JSON: a stderr line.
    }
    stderr.push(line);
  }
  return { events, stderr: stderr.join("\n") };
}
