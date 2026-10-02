import { resolveOperatorCredential, type CredentialStore } from "@clankie/credential-broker";
import {
  OPERATOR_AGENT_ROLES,
  OperatorAgentRoleSchema,
  type OperatorAgentPersona,
  type OperatorAgentRole,
} from "@clankie/protocol";
import {
  createCaptainOperatorConversationClient,
  createCaptainRouteClient,
  resolveCaptainRouteToken,
} from "../session/operator-conversations.ts";
import { commandHost } from "./io.ts";

const AGENTS_USAGE =
  "Usage: clankie agents contacts\n" +
  `       clankie agents role NAME|PERSONA_ID ${OPERATOR_AGENT_ROLES.join("|")}|none\n` +
  "       clankie agents [list] [--host ID] [--limit N]\n" +
  "       clankie agents read HOST:SESSION [--tail N | --after CURSOR]\n" +
  "       clankie agents resume HOST:SESSION [--fleet ID] [--brief TEXT]\n" +
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

function parseRole(value: string): OperatorAgentRole | null {
  if (value.toLowerCase() === "none") return null;
  const role = OperatorAgentRoleSchema.safeParse(value.toLowerCase());
  if (!role.success) throw new Error(`Unknown role ${value}; use ${OPERATOR_AGENT_ROLES.join(", ")} or none`);
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
  } = {},
): Promise<unknown> {
  if ((args[0] === "contacts" && args.length === 1) || (args[0] === "role" && args.length >= 3)) {
    const token = await resolveCaptainRouteToken({ env: options.env ?? process.env });
    const client = createCaptainOperatorConversationClient(
      createCaptainRouteClient({
        host: commandHost(options),
        ...(token ? { captainToken: token } : {}),
        ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
      }),
    );
    const personas = (await client.fleet!()).personas;
    if (args[0] === "contacts") return personas;
    return client.setPersonaRole!(
      resolvePersona(personas, args.slice(1, -1).join(" ")),
      parseRole(args.at(-1)!),
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
    const values = flags(args.slice(2), ["--fleet", "--brief"]);
    path = "/v1/agent-sessions/resume";
    method = "POST";
    body = JSON.stringify({
      ref: args[1],
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
