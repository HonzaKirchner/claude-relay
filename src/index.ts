import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { Store } from "./db.ts";
import { createHandler } from "./http.ts";
import { log } from "./log.ts";
import { ConversationRunner } from "./runner.ts";

const connectionString = process.env.DB_CONNECTION_STRING;
if (!connectionString) {
  log.error("DB_CONNECTION_STRING is not set; conversations are stored only in PostgreSQL, so the service cannot start");
  process.exit(1);
}

const options = {
  // Holds the checkouts Claude works in, one per repository (or is one checkout itself); all
  // conversation data is in the database.
  root: path.resolve(process.env.RUNNER_WORKDIR || path.join(os.homedir(), "src")),
  baseBranch: process.env.RUNNER_BASE_BRANCH || undefined,
  claudeCommand: process.env.CLAUDE_COMMAND || "claude",
  claudeModel: process.env.CLAUDE_MODEL || undefined,
  ghCommand: process.env.GH_COMMAND || "gh",
  // Base URL of this service in a browser, e.g. https://coder.example.com/@me/ws/apps/claude.
  // When set, every ConversationView carries `url`, a link to the conversation page.
  publicUrl: process.env.APP_URL || undefined,
};
// Where the pages' "Rakazo" link goes: the Rakazo app the conversations are launched from.
const rakazoUrl = process.env.RAKAZO_URL || "https://rakazo.jankirchner.cz/app";
log.info("starting", {
  root: options.root,
  baseBranch: options.baseBranch ?? "the origin's default branch",
  claude: options.claudeCommand,
  model: options.claudeModel ?? "Claude Code's default",
  gh: options.ghCommand,
  appUrl: options.publicUrl ?? "unset (responses carry no url)",
  rakazoUrl,
  logLevel: process.env.LOG_LEVEL || "info",
});

const store = new Store(connectionString);
try {
  await store.migrate();
} catch (error) {
  log.error("database unavailable, cannot start", {
    error: error instanceof Error ? error.message : String(error),
  });
  await store.close().catch(() => undefined);
  process.exit(1);
}
log.info("database ready");

const runner = new ConversationRunner({ ...options, store });
try {
  await runner.load();
} catch (error) {
  log.error("cannot start", { error: error instanceof Error ? error.message : String(error) });
  await store.close().catch(() => undefined);
  process.exit(1);
}

const port = Number(process.env.PORT || 4115);
const server = createServer(createHandler(runner, { rakazoUrl })).listen(port, "127.0.0.1", () => {
  log.info(`claude-code-runner listening on 127.0.0.1:${port}`);
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    log.info("shutting down", { signal });
    server.close();
    // Pending event writes would otherwise be lost.
    void store.close().finally(() => process.exit(0));
  });
}
