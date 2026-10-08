import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { z } from "zod";
import type { createLogger } from "@clankie/observability";

/**
 * What the model provider last said about Clankie's stored credentials, from
 * real turns only (never a paid probe). Written by the service under its
 * captain state directory; `clankie doctor` reads it.
 */
const ModelCredentialHealthSchema = z
  .object({
    schemaVersion: z.literal(1),
    providers: z.record(
      z.string(),
      z
        .object({
          /** Hosted failures need the service operator; local failures may need owner reconnection. */
          state: z.enum(["refreshed", "reconnect_required", "operator_required"]),
          at: z.string(),
          detail: z.string().max(512),
        })
        .strict(),
    ),
  })
  .strict();

type ModelCredentialHealth = z.infer<typeof ModelCredentialHealthSchema>;
export type ModelCredentialRejection = ModelCredentialHealth["providers"][string];
export type ModelCredentialEvent =
  | { event: "model.credential_rejected"; providerId: string; outcome: ModelCredentialRejection["state"] }
  | { event: "model.credential_accepted"; providerId: string };

/** Fixed metadata only: upstream errors and credentials never enter these diagnostics. */
export function modelCredentialEventLogger(logger: Pick<ReturnType<typeof createLogger>, "info" | "warn">) {
  return (event: ModelCredentialEvent): void => {
    const fields = {
      event: event.event,
      providerId: event.providerId,
      ...(event.event === "model.credential_rejected" ? { outcome: event.outcome } : {}),
    };
    if (event.event === "model.credential_rejected" && event.outcome === "operator_required")
      logger.warn(fields, "Model credential rejection requires service operator review");
    else
      logger.info(
        fields,
        event.event === "model.credential_accepted"
          ? "Model credential accepted after recorded rejection"
          : "Model credential recovery result",
      );
  };
}

export function modelCredentialHealthPath(captainStateDir: string): string {
  return join(captainStateDir, "model-credential-health.json");
}

export function readModelCredentialHealth(path: string): ModelCredentialHealth | undefined {
  try {
    return ModelCredentialHealthSchema.parse(JSON.parse(readFileSync(path, "utf8")));
  } catch {
    return undefined;
  }
}

export class ModelCredentialHealthLog {
  private readonly path: string;
  private readonly onEvent: ((event: ModelCredentialEvent) => void) | undefined;

  public constructor(path: string, onEvent?: (event: ModelCredentialEvent) => void) {
    this.path = path;
    this.onEvent = onEvent;
  }

  /** The provider rejected its credential in a real turn; record what recovery did. */
  public rejected(providerId: string, state: ModelCredentialRejection["state"], detail: string): void {
    const current = readModelCredentialHealth(this.path) ?? { schemaVersion: 1 as const, providers: {} };
    current.providers[providerId] = { state, at: new Date().toISOString(), detail: detail.slice(0, 512) };
    this.write(current);
    this.report({ event: "model.credential_rejected", providerId, outcome: state });
  }

  /** A later turn on this provider succeeded, so a recorded rejection is over. */
  public succeeded(providerId: string): void {
    const current = readModelCredentialHealth(this.path);
    if (current?.providers[providerId] === undefined) return;
    delete current.providers[providerId];
    this.write(current);
    this.report({ event: "model.credential_accepted", providerId });
  }

  private report(event: ModelCredentialEvent): void {
    try {
      this.onEvent?.(event);
    } catch {
      /* Diagnostics never fail recovery. */
    }
  }

  private write(health: ModelCredentialHealth): void {
    try {
      mkdirSync(dirname(this.path), { recursive: true });
      const temporary = `${this.path}.${String(process.pid)}.tmp`;
      writeFileSync(temporary, `${JSON.stringify(health, null, 2)}\n`, { mode: 0o600 });
      renameSync(temporary, this.path);
    } catch {
      // Diagnostics never fail a turn.
    }
  }
}
