import { SpanStatusCode, trace, type Attributes } from "@opentelemetry/api";
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

export function childLogger(logger: Logger, context: Omit<LoggerContext, "service">): Logger {
  return logger.child(context);
}

export async function withSpan<T>(
  name: string,
  attributes: Attributes,
  operation: () => Promise<T>,
): Promise<T> {
  const tracer = trace.getTracer("@clankie/observability");
  return tracer.startActiveSpan(name, { attributes }, async (span) => {
    try {
      const value = await operation();
      span.setStatus({ code: SpanStatusCode.OK });
      return value;
    } catch (error) {
      span.recordException(error instanceof Error ? error : new Error(String(error)));
      span.setStatus({
        code: SpanStatusCode.ERROR,
        message: error instanceof Error ? error.message : String(error),
      });
      throw error;
    } finally {
      span.end();
    }
  });
}

export interface DiagnosticContext {
  missionId?: string;
  taskId?: string;
  workerRunId?: string;
  profileHash?: string;
  eventId?: string;
}

export function diagnosticFields(context: DiagnosticContext): Record<string, string> {
  return Object.fromEntries(
    Object.entries(context).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
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
