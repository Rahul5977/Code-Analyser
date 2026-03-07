// src/utils/logger.ts
//
// Lightweight structured logger with coloured output.
// Swap for pino/winston in production.

type LogLevel = "INFO" | "WARN" | "ERROR" | "DEBUG";

const colorMap: Record<LogLevel, string> = {
  INFO: "\x1b[36m", // Cyan
  WARN: "\x1b[33m", // Yellow
  ERROR: "\x1b[31m", // Red
  DEBUG: "\x1b[90m", // Gray
};

const RESET = "\x1b[0m";

function format(level: LogLevel, context: string, message: string): string {
  const ts = new Date().toISOString();
  return `${colorMap[level]}[${level}]${RESET} ${ts} [${context}] ${message}`;
}

export const logger = {
  info: (ctx: string, msg: string) => console.log(format("INFO", ctx, msg)),
  warn: (ctx: string, msg: string) => console.warn(format("WARN", ctx, msg)),
  error: (ctx: string, msg: string) => console.error(format("ERROR", ctx, msg)),
  debug: (ctx: string, msg: string) => {
    if (process.env["NODE_ENV"] !== "production") {
      console.debug(format("DEBUG", ctx, msg));
    }
  },
};
