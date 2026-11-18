// The service keeps no database any more: what it remembers is in files it creates itself on
// start (see src/store.ts). This stays, doing nothing, because the Coder template runs
// `npm run db:init` before starting the service and will not start it if that fails.

console.log("claude-relay has no database to prepare.");
