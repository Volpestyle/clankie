import { resolveOperatorCredential, type CredentialStore } from "@clankie/credential-broker";
import { commandHost } from "./io.ts";

const AGENTS_USAGE =
  "Usage: clankie agents [list] [--host ID] [--limit N]\n" +
  "       clankie agents read HOST:SESSION [--tail N | --after CURSOR]\n" +
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

export async function runAgentsCommand(
  args: readonly string[],
  options: {
    env?: NodeJS.ProcessEnv;
    host?: string;
    fetchImpl?: typeof fetch;
    operatorCredentialStore?: CredentialStore;
  } = {},
): Promise<unknown> {
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
