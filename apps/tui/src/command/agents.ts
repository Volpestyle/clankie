import { runProjectRoleCommand } from "./project-role.ts";
import { ProjectIdSchema } from "@clankie/protocol/projects";
import { resolveOperatorCredential, type CredentialStore } from "@clankie/credential-broker";
import {
  OPERATOR_AGENT_ROLE_MAX,
  OPERATOR_AGENT_ROLES,
  OperatorAgentRoleSchema,
  OperatorAgentNameSchema,
  type OperatorAgentPersona,
  type OperatorAgentRole,
  OperatorConversationServiceRequestSchema,
  WorkerReportPageSchema,
} from "@clankie/protocol";
import {
  createCaptainOperatorConversationClient,
  createCaptainRouteClient,
  resolveCaptainRouteToken,
} from "../session/operator-conversations.ts";
import { commandHost } from "./io.ts";
import { text } from "node:stream/consumers";

const AGENTS_USAGE =
  "Usage: clankie agents contacts\n" +
  "       clankie agents readopt SEAT --conversation ID\n" +
  "       clankie agents reports --conversation ID [--limit N]\n" +
  "       clankie agents reports ack DELIVERY_ID... --conversation ID\n" +
  "       clankie agents reports ack --json-stdin --conversation ID\n" +
  "       clankie agents reports ack-history DELIVERY_ID... --conversation ID\n" +
  "       clankie agents efficiency [review SEAT --json-stdin] --conversation ID\n" +
  "       clankie agents tidy-worktrees --repo PATH [--merged-into REF]\n" +
  `       clankie agents role NAME|PERSONA_ID ROLE|none [--project PROJECT]   (${OPERATOR_AGENT_ROLES.join(", ")}, or "a custom role")\n` +
  "       clankie agents role ROLE --project PROJECT [--harness KIND] [--model NAME] [--effort LEVEL] [--subagent-model NAME] [--subagent-effort LEVEL] [--delegation native-first|panes] [--account LABEL] [--placement new-tab|split]\n" +
  "       clankie agents roles\n" +
  "       clankie agents rename NAME|PERSONA_ID NEW_NAME\n" +
  "       clankie agents [list] [--host ID] [--limit N]\n" +
  "       clankie agents read HOST:SESSION [--tail N | --after CURSOR]\n" +
  "       clankie agents resume HOST:SESSION --conversation ID [--fleet ID] [--brief TEXT]\n" +
  "       clankie agents hosts | hosts add ID --ssh TARGET [--shell posix|powershell] | hosts remove ID";

/** Read `--flag value` pairs; anything else is a usage error. */
function flags(args: readonly string[], allowed: readonly string[]): Map<string, string> {
  const values = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    const name = args[index]!;
    const value = args[index + 1];
    if (!allowed.includes(name) || value === undefined || values.has(name)) throw new Error(AGENTS_USAGE);
    values.set(name, value);
  }
  return values;
}

/** Whitespace-separated words, where "double" or 'single' quotes keep a phrase (a custom role) together. */
export function splitQuotedArguments(input: string): string[] {
  return [...input.matchAll(/"([^"]*)"|'([^']*)'|(\S+)/gu)].map((match) => match[1] ?? match[2] ?? match[3]!);
}

function parseRole(value: string): OperatorAgentRole | null {
  if (value.trim().toLowerCase() === "none") return null;
  const role = OperatorAgentRoleSchema.safeParse(value);
  if (!role.success)
    throw new Error(
      `Invalid role ${JSON.stringify(value)}: 1-${String(OPERATOR_AGENT_ROLE_MAX)} letters, digits, spaces and hyphens (built-ins: ${OPERATOR_AGENT_ROLES.join(", ")}), or none`,
    );
  return role.data;
}

/** A persona id, or a name that names exactly one agent (case-insensitive). */
function resolvePersona(personas: readonly OperatorAgentPersona[], target: string): string {
  const byId = personas.find((persona) => persona.personaId === target);
  if (byId) return byId.personaId;
  const named = personas.filter((persona) => persona.name.toLowerCase() === target.toLowerCase());
  if (named.length === 1) return named[0]!.personaId;
  throw new Error(
    named.length === 0
      ? `No agent named ${target}; clankie agents contacts lists them`
      : `${String(named.length)} agents are named ${target}; pass the persona id`,
  );
}

export async function runAgentsCommand(
  args: readonly string[],
  options: {
    env?: NodeJS.ProcessEnv;
    host?: string;
    fetchImpl?: typeof fetch;
    operatorCredentialStore?: CredentialStore;
    stdin?: Parameters<typeof text>[0];
  } = {},
): Promise<unknown> {
  if (args[0] === "efficiency" || args[0] === "tidy-worktrees") {
    const jsonInput = args.includes("--json-stdin");
    if (args.filter((arg) => arg === "--json-stdin").length > 1) throw new Error(AGENTS_USAGE);
    const cleanArgs = args.filter((arg) => arg !== "--json-stdin");
    const reviewing = args[0] === "efficiency" && args[1] === "review";
    const first = reviewing ? 3 : 1;
    const values = flags(
      cleanArgs.slice(first),
      args[0] === "efficiency" ? ["--conversation"] : ["--repo", "--merged-into"],
    );
    if (reviewing !== jsonInput) throw new Error(AGENTS_USAGE);
    const conversationId = values.get("--conversation");
    const repository = values.get("--repo");
    if (args[0] === "efficiency" ? !conversationId : !repository) throw new Error(AGENTS_USAGE);
    const credential = await resolveOperatorCredential({
      env: options.env ?? process.env,
      ...(options.operatorCredentialStore ? { store: options.operatorCredentialStore } : {}),
    });
    if (!credential) throw new Error("Fleet review needs the operator credential. Run clankie doctor.");
    let finding: Record<string, unknown> = {};
    if (reviewing) {
      const input: unknown = JSON.parse(await text(options.stdin ?? process.stdin));
      if (typeof input !== "object" || input === null || Array.isArray(input)) throw new Error(AGENTS_USAGE);
      finding = input as Record<string, unknown>;
      if (
        Object.keys(finding).some(
          (key) => !["offScope", "assignmentStatus", "deliverable", "progressAt", "evidence"].includes(key),
        )
      )
        throw new Error(AGENTS_USAGE);
    }
    const path = args[0] === "efficiency" ? "/v1/fleet/efficiency" : "/v1/fleet/tidy-worktrees";
    const body =
      args[0] === "efficiency"
        ? {
            ...finding,
            action: reviewing ? "review" : "show",
            conversationId,
            ...(reviewing ? { seatId: cleanArgs[2] } : {}),
          }
        : { repository, ...(values.has("--merged-into") ? { mergedInto: values.get("--merged-into") } : {}) };
    const response = await (options.fetchImpl ?? fetch)(`${commandHost(options)}${path}`, {
      method: "POST",
      body: JSON.stringify(body),
      headers: { authorization: `Bearer ${credential.token}`, "content-type": "application/json" },
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) {
      const failure: unknown = await response.json().catch(() => undefined);
      const detail =
        typeof failure === "object" && failure !== null
          ? "message" in failure && typeof failure.message === "string"
            ? failure.message
            : "error" in failure && typeof failure.error === "string"
              ? failure.error
              : undefined
          : undefined;
      throw new Error(
        `Fleet request failed: ${response.status}${detail ? `: ${detail.slice(0, 2048)}` : ""}`,
      );
    }
    return response.json();
  }
  if (args[0] === "readopt" || args[0] === "reports") {
    const jsonInput = args.includes("--json-stdin");
    if (args.filter((arg) => arg === "--json-stdin").length > 1) throw new Error(AGENTS_USAGE);
    args = args.filter((arg) => arg !== "--json-stdin");
    const first = args.findIndex((arg) => arg.startsWith("--"));
    if (first < 0) throw new Error(AGENTS_USAGE);
    const values = flags(
      args.slice(first),
      args[0] === "reports" ? ["--conversation", "--limit"] : ["--conversation"],
    );
    const conversationId = values.get("--conversation");
    if (!conversationId) throw new Error("Worker ownership and reports require --conversation ID");
    const credential = await resolveOperatorCredential({
      env: options.env ?? process.env,
      ...(options.operatorCredentialStore ? { store: options.operatorCredentialStore } : {}),
    });
    if (!credential)
      throw new Error("Worker ownership and reports need the operator credential. Run clankie doctor.");
    const transport = createCaptainRouteClient({
      host: commandHost(options),
      captainToken: credential.token,
      ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
    });
    const client = createCaptainOperatorConversationClient(transport, transport);
    if (args[0] === "readopt") {
      if (first !== 2 || jsonInput) throw new Error(AGENTS_USAGE);
      return { seatId: args[1], adopted: await client.readoptSeat!(args[1]!, conversationId) };
    }
    if (args[1] === "ack" || args[1] === "ack-history") {
      if ((jsonInput ? first !== 2 : first < 3) || values.has("--limit")) throw new Error(AGENTS_USAGE);
      let deliveryIds = args.slice(2, first);
      if (jsonInput) {
        const page = WorkerReportPageSchema.parse(JSON.parse(await text(options.stdin ?? process.stdin)));
        if (page.conversationId !== conversationId)
          throw new Error("Worker report page belongs to a different conversation");
        deliveryIds = page.ackDeliveryIds;
      }
      const operation =
        args[1] === "ack-history" ? "acknowledge_worker_report_history" : "acknowledge_worker_reports";
      const parsed = OperatorConversationServiceRequestSchema.safeParse({
        op: operation,
        schemaVersion: 1,
        conversationId,
        deliveryIds,
      });
      if (!parsed.success)
        throw new Error(
          `Supply ${args[1] === "ack-history" ? "1–1000" : "1–100"} exact delivery IDs from the returned report page`,
        );
      return {
        conversationId,
        acknowledged:
          args[1] === "ack-history"
            ? await client.acknowledgeWorkerReportHistory!(conversationId, deliveryIds)
            : await client.acknowledgeWorkerReports!(conversationId, deliveryIds),
      };
    }
    if (first !== 1 || jsonInput) throw new Error(AGENTS_USAGE);
    const limit = values.has("--limit") ? Number(values.get("--limit")) : undefined;
    if (limit !== undefined && (!Number.isInteger(limit) || limit < 1 || limit > 100))
      throw new Error(AGENTS_USAGE);
    return client.workerReports!(conversationId, limit);
  }
  const firstFlag = args.findIndex((arg) => arg.startsWith("--"));
  const roleArguments = args.slice(1, firstFlag < 0 ? args.length : firstFlag);
  if (args[0] === "role" && roleArguments.length === 1 && args.includes("--project"))
    return runProjectRoleCommand(args.slice(1), options);
  const roleFlags =
    args[0] === "role"
      ? flags(firstFlag < 0 ? [] : args.slice(firstFlag), ["--project"])
      : new Map<string, string>();
  const projectId = roleFlags.has("--project")
    ? ProjectIdSchema.parse(roleFlags.get("--project"))
    : undefined;
  if (
    (args[0] === "contacts" && args.length === 1) ||
    (args[0] === "roles" && args.length === 1) ||
    (args[0] === "role" && roleArguments.length >= 2) ||
    (args[0] === "rename" && args.length === 3)
  ) {
    const token = await resolveCaptainRouteToken({ env: options.env ?? process.env });
    const client = createCaptainOperatorConversationClient(
      createCaptainRouteClient({
        host: commandHost(options),
        ...(token ? { captainToken: token } : {}),
        ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
      }),
    );
    if (args[0] === "roles") return client.roles!();
    const personas = (await client.fleet!()).personas;
    if (args[0] === "contacts") return personas;
    if (args[0] === "rename")
      return client.updatePersona!({
        schemaVersion: 1,
        personaId: resolvePersona(personas, args[1]!),
        name: OperatorAgentNameSchema.parse(args[2]),
      });
    return client.setPersonaRole!(
      resolvePersona(personas, roleArguments.slice(0, -1).join(" ")),
      parseRole(roleArguments.at(-1)!),
      projectId,
    );
  }
  let path: string,
    method = "GET",
    body: string | undefined;
  const verb = args[0] ?? "list";
  if (verb === "list" || verb.startsWith("--")) {
    const values = flags(verb === "list" ? args.slice(1) : args, ["--host", "--limit"]);
    const query = new URLSearchParams();
    if (values.has("--host")) query.set("host", values.get("--host")!);
    if (values.has("--limit")) query.set("limit", values.get("--limit")!);
    path = `/v1/agent-sessions${query.size > 0 ? `?${query}` : ""}`;
  } else if (verb === "read" && args[1] !== undefined) {
    const values = flags(args.slice(2), ["--tail", "--after"]);
    if (values.has("--tail") && values.has("--after")) throw new Error(AGENTS_USAGE);
    const query = new URLSearchParams({ ref: args[1] });
    if (values.has("--tail")) query.set("tail", values.get("--tail")!);
    if (values.has("--after")) query.set("after", values.get("--after")!);
    path = `/v1/agent-sessions/read?${query}`;
  } else if (verb === "resume" && args[1] !== undefined) {
    const values = flags(args.slice(2), ["--fleet", "--brief", "--conversation"]);
    if (!values.has("--conversation"))
      throw new Error("Resume requires --conversation ID for the exact hiring conversation");
    path = "/v1/agent-sessions/resume";
    method = "POST";
    body = JSON.stringify({
      ref: args[1],
      conversationId: values.get("--conversation"),
      ...(values.has("--fleet") ? { fleet: values.get("--fleet") } : {}),
      ...(values.has("--brief") ? { brief: values.get("--brief") } : {}),
    });
  } else if (verb === "hosts" && args.length === 1) {
    path = "/v1/agent-hosts";
  } else if (verb === "hosts" && args[1] === "add" && args[2] !== undefined) {
    const values = flags(args.slice(3), ["--ssh", "--shell"]);
    if (!values.has("--ssh")) throw new Error(AGENTS_USAGE);
    path = "/v1/agent-hosts";
    method = "POST";
    body = JSON.stringify({ id: args[2], ssh: values.get("--ssh"), shell: values.get("--shell") ?? "posix" });
  } else if (verb === "hosts" && args[1] === "remove" && args[2] !== undefined && args.length === 3) {
    path = `/v1/agent-hosts/${encodeURIComponent(args[2])}`;
    method = "DELETE";
  } else {
    throw new Error(AGENTS_USAGE);
  }
  const credential = await resolveOperatorCredential({
    env: options.env ?? process.env,
    ...(options.operatorCredentialStore ? { store: options.operatorCredentialStore } : {}),
  });
  if (!credential) throw new Error("Agent sessions need the operator credential. Run clankie doctor.");
  const response = await (options.fetchImpl ?? fetch)(`${commandHost(options)}${path}`, {
    method,
    headers: { authorization: `Bearer ${credential.token}`, "content-type": "application/json" },
    ...(body ? { body } : {}),
    // A remote host listing walks its transcript directories over SSH.
    signal: AbortSignal.timeout(60_000),
  });
  const result = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (!response.ok)
    throw new Error(
      typeof result.detail === "string"
        ? result.detail
        : `Agent sessions: ${typeof result.error === "string" ? result.error : response.status}`,
    );
  return result;
}
