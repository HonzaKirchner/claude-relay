// Vitest global setup: gives the tests a PostgreSQL database of their own.
//
// With TEST_DATABASE_URL (any PostgreSQL the user may create databases on), the tests run in a
// fresh `claude_relay_test_<pid>` database created there and dropped afterwards; nothing else on
// that server is touched. Without it, a throwaway postgres container is started with Docker.

import { execFileSync } from "node:child_process";
import pg from "pg";
import type { TestProject } from "vitest/node";

declare module "vitest" {
  export interface ProvidedContext {
    databaseUrl: string;
  }
}

export default async function setup(project: TestProject) {
  let serverUrl = process.env.TEST_DATABASE_URL;
  let container: string | undefined;
  if (!serverUrl) {
    container = `claude-relay-test-${process.pid}`;
    try {
      execFileSync(
        "docker",
        ["run", "-d", "--rm", "--name", container, "-e", "POSTGRES_PASSWORD=test", "-p", "127.0.0.1::5432", "postgres:16-alpine"],
        { stdio: "pipe" },
      );
    } catch (error) {
      throw new Error(
        `The tests need PostgreSQL: set TEST_DATABASE_URL or make Docker available. (${error instanceof Error ? error.message : error})`,
      );
    }
    const port = execFileSync("docker", ["port", container, "5432/tcp"]).toString().trim().split(":").at(-1);
    serverUrl = `postgres://postgres:test@127.0.0.1:${port}/postgres`;
  }
  const admin = await connect(serverUrl);
  const database = `claude_relay_test_${process.pid}`;
  await admin.query(`DROP DATABASE IF EXISTS ${database}`);
  await admin.query(`CREATE DATABASE ${database}`);
  await admin.end();
  const url = new URL(serverUrl);
  url.pathname = `/${database}`;
  project.provide("databaseUrl", url.toString());

  return async () => {
    if (container) {
      execFileSync("docker", ["rm", "-f", container], { stdio: "ignore" });
      return;
    }
    const cleanup = await connect(serverUrl);
    await cleanup.query(`DROP DATABASE IF EXISTS ${database} WITH (FORCE)`);
    await cleanup.end();
  };
}

/** A fresh container accepts TCP connections only once it is really up, so retry until then. */
async function connect(connectionString: string) {
  let lastError: unknown;
  for (let attempt = 0; attempt < 120; attempt += 1) {
    const client = new pg.Client({ connectionString });
    try {
      await client.connect();
      return client;
    } catch (error) {
      lastError = error;
      await client.end().catch(() => undefined);
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
  throw new Error(`Could not connect to the test database: ${lastError instanceof Error ? lastError.message : lastError}`);
}
