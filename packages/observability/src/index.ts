import pino, { type DestinationStream, type Logger, type LoggerOptions } from "pino";

const defaultRedactPaths = [
  "req.headers.authorization",
  "headers.authorization",
  "authorization",
  "token",
  "accessToken",
  "refreshToken",
  "apiKey",
  "password",
  "secret",
  "env.OPENAI_API_KEY",
  "env.ANTHROPIC_API_KEY",
  "env.DISCORD_BOT_TOKEN",
  "credential.key",
  "credentials.*.key",
  "discord_bot.key",
];

export interface LoggerContext {
  service: string;
  version?: string;
  runnerId?: string;
  missionId?: string;
  taskId?: string;
  workerRunId?: string;
  correlationId?: string;
}

export function createLogger(
  context: LoggerContext,
  options: LoggerOptions = {},
  destination?: DestinationStream,
): Logger {
  return pino(
    {
      level: process.env.CLANKIE_LOG_LEVEL ?? "info",
      base: context,
      redact: {
        paths: defaultRedactPaths,
        censor: "[REDACTED]",
      },
      timestamp: pino.stdTimeFunctions.isoTime,
      ...options,
    },
    destination,
  );
}

export function sanitizeForSupportBundle(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sanitizeForSupportBundle);
  if (!value || typeof value !== "object") return value;
  const output: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (/^(?:key|.*token|.*secret|.*password|authorization|api[_-]?key)$/i.test(key)) {
      output[key] = "[REDACTED]";
    } else {
      output[key] = sanitizeForSupportBundle(entry);
    }
  }
  return output;
}
