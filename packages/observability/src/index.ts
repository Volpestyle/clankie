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

/** Redacts credential-shaped values before free-form text crosses a public or durable boundary. */
export function redactSensitiveText(value: string): string {
  return value
    .replace(/\bauthorization\s*:\s*(?:bearer|basic)\s+[^\s,;]+/giu, "authorization: [REDACTED]")
    .replace(/\bbearer\s+[A-Za-z0-9._~+/-]{8,}/giu, "Bearer [REDACTED]")
    .replace(/\b(?:sk-|ghp_|github_pat_|xox[baprs]-)[_A-Za-z0-9-]{8,}/gu, "[REDACTED]")
    .replace(
      /\b(?:(?:eve[_ -]?)?session(?:[_ -]?(?:id|token))?|(?:access|refresh|continuation)[_ -]?token|api[_ -]?key|provider[_ -]?credential|password|passwd|secret|credential)\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^\s,;]+)/giu,
      "[REDACTED]",
    );
}

/**
 * Collapses a warning that repeats with identical content. The first occurrence
 * is written; identical ones within `windowMs` of the last written one are only
 * counted, and that count rides on the next one written. A hot loop that warns
 * every few seconds then costs one line per window per distinct message: on
 * 2026-10-17 one seat-status warning was written about 40,000 times in 3 hours.
 */
export class RepeatedWarnings {
  private readonly seen = new Map<string, { writtenAt: number; suppressed: number }>();
  private readonly windowMs: number;
  private readonly maxKeys: number;
  private readonly now: () => number;

  public constructor(options: { windowMs?: number; maxKeys?: number; now?: () => number } = {}) {
    this.windowMs = options.windowMs ?? 10 * 60_000;
    this.maxKeys = options.maxKeys ?? 1_024;
    this.now = options.now ?? Date.now;
  }

  /** Whether to write this occurrence, and how many identical ones were held back since the last. */
  public admit(key: string): { readonly write: boolean; readonly suppressed: number } {
    const at = this.now();
    const entry = this.seen.get(key);
    if (entry !== undefined && at - entry.writtenAt < this.windowMs) {
      entry.suppressed += 1;
      return { write: false, suppressed: entry.suppressed };
    }
    const suppressed = entry?.suppressed ?? 0;
    this.seen.delete(key);
    this.seen.set(key, { writtenAt: at, suppressed: 0 });
    // Oldest first: a key that stopped repeating ages out before a live one.
    while (this.seen.size > this.maxKeys) this.seen.delete(this.seen.keys().next().value!);
    return { write: true, suppressed };
  }
}
