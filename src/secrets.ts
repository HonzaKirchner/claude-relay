import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { log } from "./log.ts";

/**
 * What whoever manages the workspace hands the service so its runs can work: Claude's OAuth
 * token, a GitHub token for pushes and pull requests, and the token and address for calling
 * the managing platform back. Each is optional; one left out stays as it was.
 */
export interface Secrets {
  claudeToken?: string;
  githubToken?: string;
  platformToken?: string;
  platformUrl?: string;
}

/** The file each is kept in, under the secrets directory. The first two are where the Coder template reads them. */
const FILES: Record<keyof Secrets, string> = {
  claudeToken: "claude-oauth-token",
  githubToken: "github-token",
  platformToken: "platform-token",
  platformUrl: "platform-url",
};

export const SECRET_KEYS = Object.keys(FILES) as Array<keyof Secrets>;

/**
 * Keeps the secrets as files only their owner can read (`~/.apix` by default, where the Coder
 * template looks on every start) and puts the two a run needs into this process's environment,
 * which every `claude`, `git` and `gh` it starts inherits. They take effect for the next run,
 * with no restart. Never logged, and never given back over HTTP.
 */
export class SecretStore {
  private readonly dir: string;
  private readonly env: NodeJS.ProcessEnv;

  constructor(dir = path.join(os.homedir(), ".apix"), env: NodeJS.ProcessEnv = process.env) {
    this.dir = dir;
    this.env = env;
  }

  /** At start: what the files hold, for what the environment does not already say. */
  async load() {
    for (const key of SECRET_KEYS) {
      const value = (await readFile(path.join(this.dir, FILES[key]), "utf8").catch(() => "")).trim();
      if (value) this.apply(key, value, false);
    }
    log.info("secrets", this.present());
  }

  /** Stores the ones given and starts using them. */
  async set(secrets: Secrets) {
    await mkdir(this.dir, { recursive: true, mode: 0o700 });
    for (const key of SECRET_KEYS) {
      const value = secrets[key];
      if (value === undefined) continue;
      const file = path.join(this.dir, FILES[key]);
      // Never readable by others, not even for a moment: created closed, then moved into place.
      await writeFile(`${file}.tmp`, `${value}\n`, { mode: 0o600 });
      await chmod(`${file}.tmp`, 0o600);
      await rename(`${file}.tmp`, file);
      this.apply(key, value, true);
    }
    log.info("secrets set", this.present());
  }

  /** Which are there, never what they are. */
  present(): Record<keyof Secrets, boolean> {
    return {
      claudeToken: Boolean(this.env.CLAUDE_CODE_OAUTH_TOKEN),
      githubToken: Boolean(this.env.GH_TOKEN),
      platformToken: this.platformToken !== undefined,
      platformUrl: this.platformUrl !== undefined,
    };
  }

  /** For calling the platform back. Kept out of the environment: a run has no use for them. */
  platformToken?: string;
  platformUrl?: string;

  private apply(key: keyof Secrets, value: string, override: boolean) {
    if (key === "platformToken" || key === "platformUrl") {
      this[key] = value;
      return;
    }
    if (key === "claudeToken") {
      if (override || !this.env.CLAUDE_CODE_OAUTH_TOKEN) this.env.CLAUDE_CODE_OAUTH_TOKEN = value;
      return;
    }
    if (!override && this.env.GH_TOKEN) return;
    this.env.GH_TOKEN = value;
    // `gh` becomes git's only credential for github.com, the empty helper first dropping every
    // other, so a push never falls back to a read-only credential the workspace came with.
    // Config from the environment outranks every config file.
    Object.assign(this.env, {
      GIT_CONFIG_COUNT: "2",
      GIT_CONFIG_KEY_0: "credential.https://github.com.helper",
      GIT_CONFIG_VALUE_0: "",
      GIT_CONFIG_KEY_1: "credential.https://github.com.helper",
      GIT_CONFIG_VALUE_1: "!gh auth git-credential",
    });
  }
}
