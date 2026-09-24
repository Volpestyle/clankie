import { readFile, writeFile } from "node:fs/promises";
import { resolveOperatorCredential, type CredentialStore } from "@clankie/credential-broker";
import { commandHost } from "./io.ts";

const USAGE =
  "Usage: clankie access list | issue REQUEST.json (--out GRANT.json | --deliver swarm) | revoke ID | linear [verify]";
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
  let deliverSwarm = false;
  if (args.length === 0 || (args.length === 1 && args[0] === "list")) {
    /* list */
  } else if (args.length === 2 && args[0] === "revoke") {
    path += encodeURIComponent(args[1]!);
    method = "DELETE";
  } else if (args[0] === "linear" && (args.length === 1 || (args.length === 2 && args[1] === "verify"))) {
    path += "linear/account";
    method = args.length === 2 ? "POST" : "GET";
  } else if (args.length === 4 && args[0] === "issue" && args[2] === "--out") {
    body = JSON.stringify(JSON.parse(await readFile(args[1]!, "utf8")));
    output = args[3]!;
    method = "POST";
  } else if (args.length === 4 && args[0] === "issue" && args[2] === "--deliver" && args[3] === "swarm") {
    const input = JSON.parse(await readFile(args[1]!, "utf8"));
    if (!input.swarm) throw new Error("Swarm delivery requires an assignment-bound grant");
    body = JSON.stringify(input);
    method = "POST";
    deliverSwarm = true;
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
  if (deliverSwarm) {
    const { token: _token, ...summary } = result;
    const id = (result.grant as { grantId: string }).grantId;
    return { ...summary, workerCommand: ["clankie", "mcp", "--swarm-grant", id], host };
  }
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
        renewable: result.renewable === true,
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
