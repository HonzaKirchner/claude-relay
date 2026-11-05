// One line per event on stdout/stderr: `<ISO time> <LEVEL> <message> key=value ...`.
// LOG_LEVEL picks the minimum level: debug, info (default), warn, error or silent.

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40, silent: 100 } as const;
type Level = Exclude<keyof typeof LEVELS, "silent">;
type Fields = Record<string, string | number | boolean | null | undefined>;

function threshold() {
  const name = process.env.LOG_LEVEL?.toLowerCase();
  return name && name in LEVELS ? LEVELS[name as keyof typeof LEVELS] : LEVELS.info;
}

function write(level: Level, message: string, fields: Fields = {}) {
  if (LEVELS[level] < threshold()) return;
  const pairs = Object.entries(fields)
    .filter(([, value]) => value !== undefined && value !== null && value !== "")
    .map(([key, value]) => `${key}=${format(value!)}`);
  const line = [new Date().toISOString(), level.toUpperCase().padEnd(5), message, ...pairs].join(" ");
  if (level === "warn" || level === "error") console.error(line);
  else console.log(line);
}

/** Quotes values with spaces, quotes or newlines so each event stays on one line. */
function format(value: string | number | boolean) {
  const text = String(value);
  return /[\s"=]/.test(text) ? JSON.stringify(text) : text;
}

export const log = {
  debug: (message: string, fields?: Fields) => write("debug", message, fields),
  info: (message: string, fields?: Fields) => write("info", message, fields),
  warn: (message: string, fields?: Fields) => write("warn", message, fields),
  error: (message: string, fields?: Fields) => write("error", message, fields),
};

/** Milliseconds since `start`, for `ms=` fields. */
export function since(start: number) {
  return Math.round(performance.now() - start);
}
