import { isAbsolute, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { ClankieApiClient } from "@clankie/api-client";
import { createLogger } from "@clankie/observability";
import type { LinearWebhookOutboundTransport } from "../../relay/src/linear-webhook-queue.ts";
import { LinearBridgeRuntime } from "./runtime.ts";

const logger = createLogger({ service: "clankie-linear-bridge", version: "0.1.0" });
const transport = await loadTransport(required("CLANKIE_LINEAR_TRANSPORT_MODULE"));
const api = new ClankieApiClient({
  baseUrl: loopbackUrl(process.env.CLANKIE_API_URL ?? "http://127.0.0.1:4310").toString(),
});
const runtime = await LinearBridgeRuntime.connect({
  transport,
  api,
  signingSecret: required("LINEAR_WEBHOOK_SIGNING_SECRET"),
  approvalSurfaceUrl: required("CLANKIE_APPROVAL_SURFACE_URL"),
  identity: {
    missionId: required("CLANKIE_LINEAR_MISSION_ID"),
    taskId: required("CLANKIE_LINEAR_TASK_ID"),
    workerRunId: required("CLANKIE_LINEAR_WORKER_RUN_ID"),
    profileHash: required("CLANKIE_PROFILE_HASH"),
    workspaceId: required("CLANKIE_LINEAR_WORKSPACE_ID"),
    appUserId: required("CLANKIE_LINEAR_APP_USER_ID"),
  },
  relayEvidence: (evidence) => logger.info(evidence, "Linear webhook bridge transition"),
  channelEvidence: (evidence) => logger.info(evidence, "Linear channel transition"),
});

const abort = new AbortController();
process.once("SIGINT", () => abort.abort());
process.once("SIGTERM", () => abort.abort());
logger.info(
  {
    missionId: required("CLANKIE_LINEAR_MISSION_ID"),
    taskId: required("CLANKIE_LINEAR_TASK_ID"),
    workerRunId: required("CLANKIE_LINEAR_WORKER_RUN_ID"),
    profileHash: required("CLANKIE_PROFILE_HASH"),
  },
  "Linear bridge connected through outbound transport",
);
await runtime.run(abort.signal);

async function loadTransport(modulePath: string): Promise<LinearWebhookOutboundTransport> {
  if (!isAbsolute(modulePath)) {
    throw new Error("CLANKIE_LINEAR_TRANSPORT_MODULE must be an absolute path");
  }
  const loaded: unknown = await import(pathToFileURL(resolve(modulePath)).href);
  if (!isRecord(loaded) || typeof loaded.createLinearWebhookOutboundTransport !== "function") {
    throw new Error("CLANKIE_LINEAR_TRANSPORT_MODULE must export createLinearWebhookOutboundTransport()");
  }
  const candidate: unknown = await loaded.createLinearWebhookOutboundTransport();
  if (!isRecord(candidate) || typeof candidate.dial !== "function") {
    throw new Error("createLinearWebhookOutboundTransport() returned an invalid transport");
  }
  return candidate as unknown as LinearWebhookOutboundTransport;
}

function required(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.length === 0) throw new Error(`${name} is required`);
  return value;
}

function loopbackUrl(value: string): URL {
  const url = new URL(value);
  if (url.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)) {
    throw new Error("CLANKIE_API_URL must be a loopback HTTP endpoint");
  }
  return url;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object";
}
