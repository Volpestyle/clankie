import { randomUUID } from "node:crypto";
import { ClankieApiClient } from "@clankie/api-client";
import { CaptainPresenceReporter } from "./reporter.ts";

let runtimeReporter: CaptainPresenceReporter | undefined;

export function captainPresenceReporter(): CaptainPresenceReporter | undefined {
  const token = process.env.CLANKIE_CAPTAIN_TOKEN?.trim();
  if (token === undefined || token.length === 0) return undefined;
  const client = new ClankieApiClient({
    baseUrl: process.env.CLANKIE_CONTROL_PLANE_URL ?? "http://127.0.0.1:4310",
    captainToken: token,
  });
  runtimeReporter ??= new CaptainPresenceReporter({
    transport: { send: (report) => client.recordCaptainPresence(report).then(() => undefined) },
    leaseId: process.env.CLANKIE_CAPTAIN_LEASE_ID?.trim() || randomUUID(),
    generationId: process.env.CLANKIE_CAPTAIN_GENERATION_ID?.trim() || randomUUID(),
    onBackgroundError: logPresenceError,
  });
  return runtimeReporter;
}

export function logPresenceError(error: unknown): void {
  process.stderr.write(
    `${JSON.stringify({
      level: "error",
      service: "clankie-captain-eve",
      component: "captain-presence",
      message: error instanceof Error ? error.message : String(error),
    })}\n`,
  );
}
