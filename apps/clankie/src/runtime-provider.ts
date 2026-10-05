import { isAbsolute } from "node:path";
import { pathToFileURL } from "node:url";
import type { CredentialStore } from "@clankie/credential-broker";
import type { Hono } from "hono";
import { publicGatewayTargetFor, type PublicGatewayRoute } from "@clankie/protocol/public-gateway";
import type { CredentialStore as ModelCredentialStore } from "@earendil-works/pi-ai";
import type { ConversationTurnContext } from "./captain/conversations.ts";
import type { PiSeatModel } from "./captain/herdr-watch.ts";
import type { HostedBodyClient } from "./hosted-body.ts";
import type { ComposerTranscriptionCloud } from "./composer-transcription.ts";

type RuntimeAuthorization = (request: Request) => Promise<true | "authentication_required" | "forbidden">;

/** Optional host policy. An ordinary installation supplies none of these hooks. */
export interface RuntimeProvider {
  quota?: {
    routes(authorize: RuntimeAuthorization): Hono;
    hireCapacity?: () => Promise<{ live: number; limit: number } | undefined>;
    gatewayRoutes?: readonly PublicGatewayRoute[];
    composer?: ComposerTranscriptionCloud;
  };
  heartbeat?: {
    begin(origin: ConversationTurnContext["origin"]): () => void;
    interactive(): void;
    authenticatedWork(isWork: boolean): void;
    start(): void;
    close(): void;
  };
  model?: {
    piSeatModel?: () => Promise<PiSeatModel | undefined>;
    onChanged(): Promise<void>;
    close(): Promise<void>;
  };
}

export interface RuntimeProviderContext {
  env: NodeJS.ProcessEnv;
  store: CredentialStore;
  /** Service-owned adapter: preserves broker refresh locks across loaded bundles. */
  modelCredentials?: ModelCredentialStore;
  body?: HostedBodyClient;
  stateRoot: string;
  herdrAvailable: () => boolean;
  logger: {
    info(fields: Record<string, unknown>, message: string): void;
    warn(fields: Record<string, unknown>, message: string): void;
  };
  /** Fixed operational fields accepted by the body's existing telemetry schema. */
  onHeartbeatReport?: (report: {
    busy: boolean;
    reasons: ("captain-turn" | "herdr-agent" | "scheduled-job")[];
    desired: "running" | "sleeping" | "suspended";
  }) => void;
}

/**
 * The host selects this installed module, never a tool argument or model output.
 * Loading is repeated by the same service entry on every launcher restart.
 * A configured provider must initialize successfully before the captain starts.
 */
export async function loadRuntimeProvider(context: RuntimeProviderContext): Promise<RuntimeProvider> {
  const path = context.env.CLANKIE_RUNTIME_PROVIDER_MODULE?.trim();
  const managed = context.body !== undefined || Boolean(context.env.CLANKIE_HOSTED_BOOTSTRAP_FILE?.trim());
  if (!path) {
    if (managed) throw new Error("runtime_provider_required");
    return {};
  }
  if (!isAbsolute(path)) throw new Error("runtime_provider_module_absolute_path_required");
  const module: unknown = await import(pathToFileURL(path).href);
  if (!record(module) || typeof module.createRuntimeProvider !== "function")
    throw new Error("runtime_provider_factory_required");
  const provider: unknown = await module.createRuntimeProvider(context);
  if (
    !record(provider) ||
    Object.keys(provider).some((key) => !["quota", "heartbeat", "model"].includes(key))
  )
    throw new Error("runtime_provider_invalid");
  methods(provider.quota, ["routes"], ["hireCapacity"]);
  methods(provider.heartbeat, ["begin", "interactive", "authenticatedWork", "start", "close"]);
  methods(provider.model, ["onChanged", "close"], ["piSeatModel"]);
  if (record(provider.quota)) {
    methods(provider.quota.composer, ["status", "transcribe", "receipt"]);
    validateRuntimeGatewayRoutes(provider.quota.gatewayRoutes);
  }
  if (
    managed &&
    (!record(provider.quota) ||
      typeof provider.quota.hireCapacity !== "function" ||
      !record(provider.heartbeat) ||
      !record(provider.model) ||
      typeof provider.model.piSeatModel !== "function")
  )
    throw new Error("managed_runtime_provider_incomplete");
  return provider as RuntimeProvider;
}

/** Host-selected routes remain exact additions; transport and administrative routes stay core-owned. */
export function validateRuntimeGatewayRoutes(value: unknown): readonly PublicGatewayRoute[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 64) throw new Error("runtime_provider_gateway_routes_invalid");
  const keys = new Set<string>();
  const routes = value.map((route: unknown): PublicGatewayRoute => {
    if (
      !record(route) ||
      typeof route !== "object" ||
      Object.keys(route).some((key) => !["method", "path", "target"].includes(key)) ||
      (route.method !== "GET" && route.method !== "POST") ||
      (route.target !== "control" && route.target !== "relay") ||
      typeof route.path !== "string" ||
      route.path.length > 512 ||
      !/^\/[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-]+)*$/u.test(route.path) ||
      /^\/(?:operator|captain|admin|internal)(?:\/|$)/u.test(route.path) ||
      /^\/v1\/(?:gateway|hooks|admin|internal)(?:\/|$)/u.test(route.path) ||
      /^\/(?:fleet|account|gateway)\//u.test(route.path) ||
      publicGatewayTargetFor("GET", route.path) !== undefined ||
      publicGatewayTargetFor("POST", route.path) !== undefined
    )
      throw new Error("runtime_provider_gateway_routes_invalid");
    const key = `${route.method} ${route.path}`;
    if (keys.has(key)) throw new Error("runtime_provider_gateway_routes_invalid");
    keys.add(key);
    return Object.freeze({ method: route.method, path: route.path, target: route.target });
  });
  return Object.freeze(routes);
}

function record(value: unknown): value is Record<string, unknown> {
  return (
    value !== null && (typeof value === "object" || typeof value === "function") && !Array.isArray(value)
  );
}

function methods(value: unknown, required: readonly string[], optional: readonly string[] = []): void {
  if (value === undefined) return;
  if (
    !record(value) ||
    required.some((name) => typeof value[name] !== "function") ||
    optional.some((name) => value[name] !== undefined && typeof value[name] !== "function")
  )
    throw new Error("runtime_provider_invalid");
}
