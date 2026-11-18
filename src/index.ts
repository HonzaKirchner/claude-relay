import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { createHandler } from "./http.ts";
import { log } from "./log.ts";
import { ConversationRunner } from "./runner.ts";
import { SecretStore } from "./secrets.ts";
import { Store } from "./store.ts";

const options = {
  // Holds the checkouts Claude works in, one per repository (or is one checkout itself).
  root: path.resolve(process.env.RUNNER_WORKDIR || path.join(os.homedir(), "src")),
  baseBranch: process.env.RUNNER_BASE_BRANCH || undefined,
  claudeCommand: process.env.CLAUDE_COMMAND || "claude",
  claudeModel: process.env.CLAUDE_MODEL || undefined,
  ghCommand: process.env.GH_COMMAND || "gh",
};
// What the service remembers across a restart, and the secrets it is handed: both on the
// workspace's persistent disk, outside every checkout.
const stateDir = path.resolve(process.env.RUNNER_STATE_DIR || path.join(os.homedir(), ".claude-relay"));
const secretsDir = path.resolve(process.env.RUNNER_SECRETS_DIR || path.join(os.homedir(), ".apix"));
log.info("starting", {
  root: options.root,
  state: stateDir,
  baseBranch: options.baseBranch ?? "the origin's default branch",
  claude: options.claudeCommand,
  model: options.claudeModel ?? "Claude Code's default",
  gh: options.ghCommand,
  logLevel: process.env.LOG_LEVEL || "info",
});

const store = new Store(stateDir);
const secrets = new SecretStore(secretsDir);
const runner = new ConversationRunner({ ...options, store });
try {
  await store.prepare();
  await secrets.load();
  await runner.load();
} catch (error) {
  log.error("cannot start", { error: error instanceof Error ? error.message : String(error) });
  process.exit(1);
}

// A slip anywhere would otherwise take the whole service down, and its caller would read the
// dropped connection as "workspace not reachable". Logged and survived instead; every request
// path answers its own errors, so this is the last resort, not the normal route.
process.on("uncaughtException", (error) => {
  log.error("uncaught exception", { error: error.stack ?? error.message });
});
process.on("unhandledRejection", (reason) => {
  log.error("unhandled rejection", { error: reason instanceof Error ? (reason.stack ?? reason.message) : String(reason) });
});

const port = Number(process.env.PORT || 4115);
const server = createServer(createHandler(runner, secrets)).listen(port, "127.0.0.1", () => {
  log.info(`claude-code-runner listening on 127.0.0.1:${port}`);
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    log.info("shutting down", { signal });
    server.close();
    // Pending event writes would otherwise be lost.
    void store.flush().finally(() => process.exit(0));
  });
}
