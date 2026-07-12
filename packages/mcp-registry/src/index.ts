import { readFile } from "node:fs/promises";
import {
  createConnectorActionClassifier,
  decideAction,
  type CompiledDoctrine,
  type ConnectorActionMetadata,
} from "@clankie/doctrine";
import { TaskKindSchema, type ActionRequest, type TaskKind } from "@clankie/protocol";
import { parse as parseYaml } from "yaml";
import { z } from "zod";

/**
 * Operator-authored MCP connector registry. The registry file is trusted
 * runner configuration: models never author or mutate it, and every declared
 * tool carries exactly one doctrine risk class. A tool that is not declared
 * here is never projected into a worker, which preserves the doctrine rule
 * that unclassified unknown actions are denied.
 */

export const MCP_REGISTRY_SCHEMA_VERSION = "1";

/** Lowercase with underscores so the name is valid as a TOML dotted key and a Claude tool prefix. */
const McpServerNameSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z][a-z0-9_]*$/u, "MCP server names are lowercase alphanumerics with underscores");

const McpToolNameSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z][A-Za-z0-9_-]*$/u, "MCP tool names are alphanumerics with underscores or dashes");

const CredentialEnvironmentNameSchema = z
  .string()
  .regex(/^[A-Z][A-Z0-9_]*$/u, "Credential environment entries are environment variable names");

/**
 * Narrative-write is deliberately excluded: that class is a closed whitelist
 * owned by the tracker and Discord presence planes, never generic MCP tools.
 */
export const McpToolRiskClassSchema = z.enum([
  "read",
  "reversible-write",
  "irreversible-write",
  "publish-external",
  "destructive",
]);
export type McpToolRiskClass = z.infer<typeof McpToolRiskClassSchema>;

export const McpServerToolSchema = z.object({
  name: McpToolNameSchema,
  riskClass: McpToolRiskClassSchema,
  description: z.string().optional(),
});
export type McpServerTool = z.infer<typeof McpServerToolSchema>;

export const McpServerTransportSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("stdio"),
    command: z.string().min(1),
    args: z.array(z.string()).default([]),
    /** Static, non-secret variables passed to the server process verbatim. */
    staticEnvironment: z.record(CredentialEnvironmentNameSchema, z.string()).default({}),
  }),
  z.object({
    type: z.literal("http"),
    url: z.string().url(),
  }),
]);
export type McpServerTransport = z.infer<typeof McpServerTransportSchema>;

export const McpServerDefinitionSchema = z.object({
  name: McpServerNameSchema,
  description: z.string().min(1),
  transport: McpServerTransportSchema,
  /**
   * Names of runner-host environment variables forwarded to the server
   * process. This is a positive allowlist; the server never inherits the
   * runner environment wholesale.
   */
  credentialEnvironment: z.array(CredentialEnvironmentNameSchema).default([]),
  /** Task kinds allowed to see this server. Omitted means every worker task kind. */
  kinds: z.array(TaskKindSchema).optional(),
  tools: z
    .array(McpServerToolSchema)
    .min(1)
    .refine(
      (tools) => new Set(tools.map((tool) => tool.name)).size === tools.length,
      "MCP tool names must be unique per server",
    ),
});
export type McpServerDefinition = z.infer<typeof McpServerDefinitionSchema>;

export const McpRegistrySchema = z.object({
  schemaVersion: z.literal(MCP_REGISTRY_SCHEMA_VERSION),
  servers: z
    .array(McpServerDefinitionSchema)
    .default([])
    .refine(
      (servers) => new Set(servers.map((server) => server.name)).size === servers.length,
      "MCP server names must be unique",
    ),
});
export type McpRegistry = z.infer<typeof McpRegistrySchema>;

export async function loadMcpRegistryFile(path: string): Promise<McpRegistry> {
  const raw = await readFile(path, "utf8");
  return McpRegistrySchema.parse(parseYaml(raw));
}

/** The doctrine action string for one MCP tool. */
export function mcpToolAction(serverName: string, toolName: string): string {
  return `mcp.${serverName}.${toolName}`;
}

/** Connector metadata registering every declared tool with the doctrine classifier. */
export function mcpConnectorActionMetadata(registry: McpRegistry): ConnectorActionMetadata[] {
  return registry.servers.flatMap((server) =>
    server.tools.map(
      (tool): ConnectorActionMetadata => ({
        action: mcpToolAction(server.name, tool.name),
        riskClass: tool.riskClass,
      }),
    ),
  );
}

export interface McpToolGrant {
  server: string;
  tool: string;
  action: string;
  riskClass: McpToolRiskClass;
  effect: "allow" | "deny" | "require_approval";
  reason: string;
}

export interface McpGrantProjection {
  /** Tools doctrine allows for direct, unattended worker execution. */
  allowed: McpToolGrant[];
  /** Tools declared in the registry but withheld from workers by doctrine. */
  withheld: McpToolGrant[];
}

/**
 * Projects the registry through compiled doctrine. Workers only ever receive
 * tools whose decision is exactly `allow`: a worker cannot pause mid-tool for
 * a human, so `require_approval` and `deny` both withhold the tool. Approval-
 * gated actions belong to the privileged connector path, not worker tool sets.
 *
 * The projection is evaluated once per fleet build with a low-risk readiness
 * request, so profiles gate MCP tools through action and risk-class defaults
 * rather than per-mission conditional rules.
 */
export function projectMcpToolGrants(
  registry: McpRegistry,
  doctrine: CompiledDoctrine,
  input: { principalId: string },
): McpGrantProjection {
  const classify = createConnectorActionClassifier(mcpConnectorActionMetadata(registry));
  const allowed: McpToolGrant[] = [];
  const withheld: McpToolGrant[] = [];
  for (const server of registry.servers) {
    for (const tool of server.tools) {
      const action = mcpToolAction(server.name, tool.name);
      const decision = decideAction(
        doctrine,
        projectionRequest(action, input.principalId, doctrine),
        classify(action),
      );
      const grant: McpToolGrant = {
        server: server.name,
        tool: tool.name,
        action,
        riskClass: tool.riskClass,
        effect: decision.effect,
        reason: decision.reason,
      };
      (decision.effect === "allow" ? allowed : withheld).push(grant);
    }
  }
  return { allowed, withheld };
}

export const WEB_SEARCH_ACTION = "web.search";
export const WEB_FETCH_ACTION = "web.fetch";
export const WEB_BROWSE_ACTION = "web.browse";

export interface WebToolGrants {
  webSearch: boolean;
  webFetch: boolean;
}

/** Projects read-only browser control through the same connector-neutral read boundary. */
export function projectBrowserToolGrant(doctrine: CompiledDoctrine, input: { principalId: string }): boolean {
  const classify = createConnectorActionClassifier([{ action: WEB_BROWSE_ACTION, riskClass: "read" }]);
  return (
    decideAction(
      doctrine,
      projectionRequest(WEB_BROWSE_ACTION, input.principalId, doctrine),
      classify(WEB_BROWSE_ACTION),
    ).effect === "allow"
  );
}

/**
 * Projects the provider-native web research actions through doctrine. Both
 * are read-class connector actions, so presets allow them via the read risk
 * class while tightened overlays can deny the exact actions.
 */
export function projectWebToolGrants(
  doctrine: CompiledDoctrine,
  input: { principalId: string },
): WebToolGrants {
  const classify = createConnectorActionClassifier([
    { action: WEB_SEARCH_ACTION, riskClass: "read" },
    { action: WEB_FETCH_ACTION, riskClass: "read" },
  ]);
  const effect = (action: string) =>
    decideAction(doctrine, projectionRequest(action, input.principalId, doctrine), classify(action)).effect;
  return {
    webSearch: effect(WEB_SEARCH_ACTION) === "allow",
    webFetch: effect(WEB_FETCH_ACTION) === "allow",
  };
}

function projectionRequest(action: string, principalId: string, doctrine: CompiledDoctrine): ActionRequest {
  return {
    id: `mcp-projection:${action}`,
    principal: { kind: "worker", id: principalId },
    action,
    resource: { type: "mcp-tool", id: action },
    context: {
      missionId: "provider-readiness",
      risk: "low",
      profileHash: doctrine.profileHash,
    },
  };
}

export interface ResolvedCredentialEnvironment {
  environment: Record<string, string>;
  missing: string[];
}

/** Resolves a server's credential allowlist against the runner-host environment. */
export function resolveCredentialEnvironment(
  names: readonly string[],
  hostEnvironment: NodeJS.ProcessEnv,
): ResolvedCredentialEnvironment {
  const environment: Record<string, string> = {};
  const missing: string[] = [];
  for (const name of names) {
    const value = hostEnvironment[name]?.trim();
    if (value) environment[name] = value;
    else missing.push(name);
  }
  return { environment, missing };
}

/** One server projected for a specific worker harness, carrying only doctrine-allowed tools. */
export interface McpWorkerServer {
  name: string;
  kinds?: TaskKind[];
  /** Claude Agent SDK / MCP-client shaped transport configuration. */
  config:
    | { type: "stdio"; command: string; args: string[]; env: Record<string, string> }
    | { type: "http"; url: string };
  /** Bare tool names doctrine allows on this server. */
  allowedTools: string[];
}

export interface McpWorkerProjection {
  servers: McpWorkerServer[];
  /** Servers withheld entirely, with the reason (missing credentials or no allowed tools). */
  withheldServers: Array<{ name: string; reason: string }>;
}

/**
 * Builds per-server worker configuration from doctrine grants.
 *
 * `toolGranularity: "tool"` (Claude) injects a server when at least one of its
 * tools is allowed and enforces the per-tool allowlist downstream.
 * `toolGranularity: "server"` (Codex) injects a server only when every
 * declared tool is allowed, because that harness cannot filter individual
 * MCP tools.
 */
export function projectMcpWorkerServers(
  registry: McpRegistry,
  grants: McpGrantProjection,
  input: {
    hostEnvironment: NodeJS.ProcessEnv;
    toolGranularity: "tool" | "server";
  },
): McpWorkerProjection {
  const servers: McpWorkerServer[] = [];
  const withheldServers: Array<{ name: string; reason: string }> = [];
  for (const server of registry.servers) {
    const allowedTools = grants.allowed
      .filter((grant) => grant.server === server.name)
      .map((grant) => grant.tool);
    if (allowedTools.length === 0) {
      withheldServers.push({ name: server.name, reason: "doctrine allows none of its tools" });
      continue;
    }
    if (input.toolGranularity === "server" && allowedTools.length !== server.tools.length) {
      withheldServers.push({
        name: server.name,
        reason: "harness filters tools per server and doctrine withheld at least one tool",
      });
      continue;
    }
    const config = serverConfig(server, input.hostEnvironment);
    if ("missing" in config) {
      withheldServers.push({
        name: server.name,
        reason: `credential environment unavailable: ${config.missing.join(", ")}`,
      });
      continue;
    }
    servers.push({
      name: server.name,
      ...(server.kinds ? { kinds: server.kinds } : {}),
      config: config.value,
      allowedTools,
    });
  }
  return { servers, withheldServers };
}

function serverConfig(
  server: McpServerDefinition,
  hostEnvironment: NodeJS.ProcessEnv,
): { value: McpWorkerServer["config"] } | { missing: string[] } {
  if (server.transport.type === "http") {
    return { value: { type: "http", url: server.transport.url } };
  }
  const credentials = resolveCredentialEnvironment(server.credentialEnvironment, hostEnvironment);
  if (credentials.missing.length > 0) return { missing: credentials.missing };
  return {
    value: {
      type: "stdio",
      command: server.transport.command,
      args: server.transport.args,
      env: { ...server.transport.staticEnvironment, ...credentials.environment },
    },
  };
}
