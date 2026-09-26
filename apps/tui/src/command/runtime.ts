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
  } else if ((args[0] === "capacity" && args.length === 3) || (args[0] === "budget" && args.length === 2)) {
    const raw = args.at(-1)!;
    if (raw !== "--clear" && (!/^\d+$/u.test(raw) || !Number.isSafeInteger(Number(raw))))
      throw new Error("Use a nonnegative integer limit or --clear for unlimited");
    const limit = raw === "--clear" ? null : Number(raw);
    method = "POST";
    body = JSON.stringify(
      args[0] === "budget"
        ? { action: "budget", budget: limit }
        : { action: "capacity", id: args[1], capacity: limit },
    );
  } else if (args[0] === "workspaces" && args.length >= 3) {
    const workspaces: Array<{ kind: "repository" | "directory"; path: string }> = [];
    if (!(args.length === 3 && args[2] === "--clear")) {
      for (let index = 2; index < args.length; index += 2) {
        const kind = args[index],
          target = args[index + 1];
        if (!["--repo", "--dir"].includes(kind!) || !target?.startsWith("/"))
          throw new Error("Use workspaces ID (--repo /checkout | --dir /directory)... or --clear");
        workspaces.push({ kind: kind === "--repo" ? "repository" : "directory", path: target });
      }
    }
    method = "POST";
    body = JSON.stringify({ action: "workspaces", id: args[1], workspaces });
  } else if (args[0] === "disconnect" && args.length === 2) {
    method = "DELETE";
    path += `/${encodeURIComponent(args[1]!)}`;
  } else if (args.length > 1 || (args[0] && !["list", "status"].includes(args[0]))) {
    throw new Error(
      "Usage: clankie runtime [list|status] | connect ID (--session NAME | --socket PATH) | disconnect ID | workspaces ID (--repo PATH | --dir PATH)... | workspaces ID --clear | capacity ID N|--clear | budget N|--clear (limits count per coordinator scope)",
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
