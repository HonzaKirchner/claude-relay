// Creates or updates the tables in the database at
// DB_CONNECTION_STRING. The service does the same on start; this is for doing
// it by hand. Idempotent.
//
//   npm run db:init      (loads .env if present)

import { Store } from "../src/db.ts";

const connectionString = process.env.DB_CONNECTION_STRING;
if (!connectionString) {
  console.error("DB_CONNECTION_STRING is not set (add it to .env or the environment).");
  process.exit(1);
}

const store = new Store(connectionString);
try {
  await store.migrate();
  console.log("Database schema is up to date.");
} catch (error) {
  console.error("Database initialisation failed:", error instanceof Error ? error.message : error);
  process.exitCode = 1;
} finally {
  await store.close();
}
