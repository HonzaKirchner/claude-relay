import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { createHandler } from "./http.ts";
import { AgentRunner } from "./runner.ts";

const runner = new AgentRunner({
  dataDir: process.env.RUNNER_DATA_DIR || path.join(os.homedir(), ".claude-code-runner"),
  claudeCommand: process.env.CLAUDE_COMMAND || "claude",
  ghCommand: process.env.GH_COMMAND || "gh",
});
await runner.load();

const port = Number(process.env.PORT || 4115);
createServer(createHandler(runner)).listen(port, "127.0.0.1", () => {
  console.log(`claude-code-runner listening on 127.0.0.1:${port}`);
});
