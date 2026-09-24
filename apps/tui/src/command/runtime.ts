import { readFile } from "node:fs/promises";
import { resolveOperatorCredential, type CredentialStore } from "@clankie/credential-broker";
import { commandHost } from "./io.ts";

export async function runRuntimeCommand(
  args: readonly string[],
  options: {
    env?: NodeJS.ProcessEnv;
    host?: string;
    fetchImpl?: typeof fetch;
    operatorCredentialStore?: CredentialStore;
  } = {},
) {
  let path = "/v1/runtime-connections",
    method = "GET",
    body: string | undefined;
  if (args[0] === "inventory" && args.length === 1) {
    path = "/v1/connections";
  } else if (args[0] === "connect" && args.length === 2) {
    method = "POST";
    body = JSON.stringify(JSON.parse(await readFile(args[1]!, "utf8")));
  } else if (args[0] === "connect" && args.length === 4 && ["--session", "--socket"].includes(args[2]!)) {
    method = "POST";
    body = JSON.stringify({ id: args[1], [args[2] === "--session" ? "session" : "socketPath"]: args[3] });
  } else if (args[0] === "disconnect" && args.length === 2) {
    method = "DELETE";
    path += `/${encodeURIComponent(args[1]!)}`;
  } else if (args.length > 1 || (args[0] && !["list", "status"].includes(args[0]))) {
    throw new Error(
      "Usage: clankie runtime [list|status] | connect ID (--session NAME | --socket PATH) | disconnect ID",
    );
  }
  const credential = await resolveOperatorCredential({
    env: options.env ?? process.env,
    ...(options.operatorCredentialStore ? { store: options.operatorCredentialStore } : {}),
  });
  if (!credential) throw new Error("Runtime connections need the operator credential");
  const response = await (options.fetchImpl ?? fetch)(`${commandHost(options)}${path}`, {
    method,
    headers: { authorization: `Bearer ${credential.token}`, "content-type": "application/json" },
    ...(body ? { body } : {}),
    signal: AbortSignal.timeout(30_000),
  });
  const result = (await response.json()) as Record<string, unknown>;
  if (!response.ok)
    throw new Error(
      typeof result.detail === "string" ? result.detail : `Runtime connection: ${response.status}`,
    );
  return result;
}
