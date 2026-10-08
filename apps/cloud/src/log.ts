type Level = "debug" | "info" | "warn" | "error";
const order: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export interface Logger { debug(message: string, fields?: Record<string, unknown>): void; info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void; error(message: string, fields?: Record<string, unknown>): void; }

/** JSON lines on stdout/stderr. Callers pass identifiers and codes, never tokens or request bodies. */
export const createLogger = (minimum: Level = "info"): Logger => {
  const write = (level: Level) => (message: string, fields: Record<string, unknown> = {}) => {
    if (order[level] < order[minimum]) return;
    const line = JSON.stringify({ time: new Date().toISOString(), level, message, ...fields });
    (level === "error" || level === "warn" ? process.stderr : process.stdout).write(`${line}\n`);
  };
  return { debug: write("debug"), info: write("info"), warn: write("warn"), error: write("error") };
};
