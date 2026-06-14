type LogLevel = "info" | "warn" | "error" | "debug";

const levelPriority: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40
};

const readLogLevel = (): LogLevel => {
  const raw = process.env.LOG_LEVEL?.toLowerCase();

  return raw === "debug" || raw === "warn" || raw === "error" ? raw : "info";
};

export class Logger {
  private readonly minLevel = readLogLevel();

  log(level: LogLevel, message: string, meta?: Record<string, unknown>): void {
    if (levelPriority[level] < levelPriority[this.minLevel]) {
      return;
    }

    const timestamp = new Date().toISOString();
    const payload = meta ? ` ${JSON.stringify(meta)}` : "";
    const line = `[${timestamp}] [${level.toUpperCase()}] ${message}${payload}`;

    if (level === "error") {
      console.error(line);
      return;
    }

    if (level === "warn") {
      console.warn(line);
      return;
    }

    console.log(line);
  }

  info(message: string, meta?: Record<string, unknown>): void {
    this.log("info", message, meta);
  }

  warn(message: string, meta?: Record<string, unknown>): void {
    this.log("warn", message, meta);
  }

  error(message: string, meta?: Record<string, unknown>): void {
    this.log("error", message, meta);
  }

  debug(message: string, meta?: Record<string, unknown>): void {
    this.log("debug", message, meta);
  }
}
