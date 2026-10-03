import { readFile, writeFile } from "node:fs/promises";
import { resolveOperatorCredential, type CredentialStore } from "@clankie/credential-broker";
import { commandHost } from "./io.ts";

const USAGE =
  "Usage: clankie access list | issue REQUEST.json --out GRANT.json | project NAME SERVER [--tool NAME]... | revoke ID | linear [verify]";
export async function runAccessCommand(
  args: readonly string[],
  options: {
    env?: NodeJS.ProcessEnv;
    host?: string;
    fetchImpl?: typeof fetch;
    operatorCredentialStore?: CredentialStore;
  } = {},
) {
  let path = "/v1/worker-grants/",
    method = "GET",
    body: string | undefined;
  let output: string | undefined;
  if (args.length === 0 || (args.length === 1 && args[0] === "list")) {
    /* list */
  } else if (args.length === 2 && args[0] === "revoke") {
    path += encodeURIComponent(args[1]!);
    method = "DELETE";
  } else if (args[0] === "linear" && (args.length === 1 || (args.length === 2 && args[1] === "verify"))) {
    path += "linear/account";
    method = args.length === 2 ? "POST" : "GET";
  } else if (args[0] === "project" && args.length >= 3) {
    // Explicit owner grant. Membership and the account are rechecked on every list and call.
    const tools: string[] = [];
    for (let index = 3; index < args.length; index += 2) {
      if (args[index] !== "--tool" || args[index + 1] === undefined) throw new Error(USAGE);
      tools.push(args[index + 1]!);
    }
    body = JSON.stringify({
      principalId: `project:${args[1]}`,
      workId: `project:${args[1]}`,
      server: args[2],
      project: args[1],
      tools: tools.map((name) => ({ name })),
    });
    method = "POST";
  } else if (args[0] === "fleet") {
    throw new Error(
      "Fleet grants are retired. Use clankie access project NAME SERVER, then clankie access revoke ID for each old grant.",
    );
  } else if (args.length === 4 && args[0] === "issue" && args[2] === "--out") {
    body = JSON.stringify(JSON.parse(await readFile(args[1]!, "utf8")));
    output = args[3]!;
    method = "POST";
  } else throw new Error(USAGE);
  const credential = await resolveOperatorCredential({
    env: options.env ?? process.env,
    ...(options.operatorCredentialStore === undefined ? {} : { store: options.operatorCredentialStore }),
  });
  if (credential === undefined) throw new Error("Worker access management needs the operator credential");
  const host = commandHost(options);
  const response = await (options.fetchImpl ?? fetch)(`${host}${path}`, {
    method,
    headers: { authorization: `Bearer ${credential.token}`, "content-type": "application/json" },
    ...(body === undefined ? {} : { body }),
    signal: AbortSignal.timeout(30_000),
  });
  const result = (await response.json()) as Record<string, unknown>;
  if (!response.ok)
    throw new Error(typeof result.detail === "string" ? result.detail : `Worker access: ${response.status}`);
  if (output === undefined) return result;
  if (typeof result.token !== "string") throw new Error("Service returned no worker credential");
  // A caller explicitly chooses the destination; never overwrite another grant
  // or print this credential into a TUI transcript or command log.
  try {
    await writeFile(
      output,
      JSON.stringify({
        endpoint: `${host}/v1/worker-mcp`,
        token: result.token,
        grant: result.grant,
      }),
      { flag: "wx", mode: 0o600 },
    );
  } catch (error) {
    // Issuance succeeded but delivery failed. Revoke that one grant rather than
    // leaving a usable credential whose disposition the caller cannot inspect.
    const id = (result.grant as { grantId: string }).grantId;
    try {
      const revoked = await (options.fetchImpl ?? fetch)(
        `${host}/v1/worker-grants/${encodeURIComponent(id)}`,
        {
          method: "DELETE",
          headers: { authorization: `Bearer ${credential.token}` },
          signal: AbortSignal.timeout(10_000),
        },
      );
      if (!revoked.ok) throw new Error(`HTTP ${revoked.status}`);
    } catch {
      throw new Error(
        `Grant file could not be written; revocation is unconfirmed. Revoke grant ${id} with clankie access revoke.`,
        { cause: error },
      );
    }
    throw error;
  }
  const { token: _token, ...summary } = result;
  return { ...summary, grantFile: output };
}
