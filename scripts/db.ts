// A local PostgreSQL for development, in a Docker container named `claude-relay-pg`.
// User, password, database and port come from DB_CONNECTION_STRING (falling back to the
// README's sample .env), so the container always matches what the service connects to.
//
//   npm run db:start     create the container, or start it if it exists; waits until it is ready
//   npm run db:stop      stop it; the data is kept
//   npm run db:reset     delete the container and its data, then start an empty one
//
// The data lives in the Docker volume `claude-relay-pg-data`, so it survives db:stop.

import { execFileSync } from "node:child_process";

const CONTAINER = "claude-relay-pg";
const VOLUME = "claude-relay-pg-data";
const DEFAULT_URL = "postgres://postgres:dev@127.0.0.1:5432/claude_relay";

const url = new URL(process.env.DB_CONNECTION_STRING || DEFAULT_URL);
if (!["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) {
  console.error(`DB_CONNECTION_STRING points at ${url.hostname}, not this machine; refusing to manage it with Docker.`);
  process.exit(1);
}
const user = decodeURIComponent(url.username) || "postgres";
const password = decodeURIComponent(url.password) || "dev";
const database = url.pathname.slice(1) || "claude_relay";
const port = url.port || "5432";

const command = process.argv[2];
try {
  if (command === "start") await start();
  else if (command === "stop") stop();
  else if (command === "reset") {
    remove();
    await start();
  } else {
    console.error("Usage: node scripts/db.ts start|stop|reset");
    process.exitCode = 1;
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}

async function start() {
  const state = containerState();
  if (state === "running") {
    console.log(`${CONTAINER} is already running on 127.0.0.1:${port}.`);
  } else if (state) {
    docker("start", CONTAINER);
    console.log(`Started ${CONTAINER}.`);
  } else {
    docker(
      "run", "-d", "--name", CONTAINER,
      "-e", `POSTGRES_USER=${user}`,
      "-e", `POSTGRES_PASSWORD=${password}`,
      "-e", `POSTGRES_DB=${database}`,
      "-v", `${VOLUME}:/var/lib/postgresql/data`,
      "-p", `127.0.0.1:${port}:5432`,
      "postgres:16-alpine",
    );
    console.log(`Created ${CONTAINER} (database ${database} on 127.0.0.1:${port}).`);
  }
  await waitUntilReady();
}

function stop() {
  if (containerState() !== "running") {
    console.log(`${CONTAINER} is not running.`);
    return;
  }
  docker("stop", CONTAINER);
  console.log(`Stopped ${CONTAINER}; its data is kept.`);
}

function remove() {
  if (containerState()) docker("rm", "-f", CONTAINER);
  try {
    docker("volume", "rm", VOLUME);
  } catch {
    // No volume yet.
  }
  console.log(`Removed ${CONTAINER} and its data.`);
}

/** "running", "exited", ... or undefined when the container does not exist. */
function containerState() {
  try {
    return docker("inspect", "-f", "{{.State.Status}}", CONTAINER) || undefined;
  } catch {
    return undefined;
  }
}

/** pg_isready over TCP: the init scripts of a fresh container run on a socket-only server first. */
async function waitUntilReady() {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      docker("exec", CONTAINER, "pg_isready", "-h", "127.0.0.1", "-U", user, "-d", database);
      console.log("PostgreSQL is ready.");
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
  throw new Error(`${CONTAINER} did not become ready within 30 s; see \`docker logs ${CONTAINER}\`.`);
}

function docker(...args: string[]) {
  try {
    return execFileSync("docker", args, { stdio: ["ignore", "pipe", "pipe"] }).toString().trim();
  } catch (error) {
    const stderr = (error as { stderr?: Buffer }).stderr?.toString().trim();
    throw new Error(`docker ${args[0]} failed${stderr ? `: ${stderr}` : ""}`);
  }
}
