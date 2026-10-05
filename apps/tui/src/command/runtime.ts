import { readFile } from "node:fs/promises";
import { posix, win32 } from "node:path";
import { resolveOperatorCredential, type CredentialStore } from "@clankie/credential-broker";
import { commandHost } from "./io.ts";
import { confirmMachineSetupApproval, machineSetupContext } from "./machine-setup.ts";

export async function runRuntimeCommand(
  args: readonly string[],
  options: {
    env?: NodeJS.ProcessEnv;
    host?: string;
    fetchImpl?: typeof fetch;
    operatorCredentialStore?: CredentialStore;
    cwd?: string;
  } = {},
): Promise<Record<string, unknown>> {
  let path = "/v1/runtime-connections",
    method = "GET",
    body: string | undefined;
  if (args[0] === "reconnect" && args.length === 2) {
    if (args[1] === "default") throw new Error("Use /herdr to change his default workspace");
    const inventory = await runRuntimeCommand(["list"], options);
    const connections = inventory.connections as Record<string, unknown>[] | undefined;
    const connection = connections?.find((entry) => entry.id === args[1]);
    if (!connection) throw new Error("Unknown named connection");
    const fields = Object.fromEntries(
      ["id", "machine", "kind", "session", "socketPath", "ssh", "capabilities", "workspaces", "capacity"]
        .filter(
          (key) =>
            connection[key] !== undefined && !(key === "capacity" && connection.capacitySource === "default"),
        )
        .map((key) => [key, connection[key]]),
    );
    method = "POST";
    body = JSON.stringify(fields);
  } else if (args[0] === "connect-machine" && args.length === 4) {
    method = "POST";
    body = JSON.stringify({ id: args[1], machine: args[2], session: args[3] });
  } else if (args[0] === "inventory" && args.length === 1) {
    path = "/v1/connections";
  } else if (args[0] === "connect" && args.length === 2) {
    method = "POST";
    body = JSON.stringify(JSON.parse(await readFile(args[1]!, "utf8")));
  } else if (args[0] === "connect" && args.length === 4 && ["--session", "--socket"].includes(args[2]!)) {
    method = "POST";
    body = JSON.stringify({ id: args[1], [args[2] === "--session" ? "session" : "socketPath"]: args[3] });
  } else if (args[0] === "connect" && args.includes("--ssh")) {
    // An ssh fleet (ADR 0184): a host from the owner's ssh config and the
    // remote session already running there.
    const flags = new Map<string, string>();
    for (let index = 2; index < args.length; index += 2) {
      const flag = args[index],
        value = args[index + 1];
      if (!["--ssh", "--session", "--shell"].includes(flag!) || value === undefined || flags.has(flag!))
        throw new Error("Use connect ID --ssh HOST --session NAME [--shell posix|powershell]");
      flags.set(flag!, value);
    }
    const shell = flags.get("--shell") ?? "posix";
    if (!flags.has("--session") || !["posix", "powershell"].includes(shell))
      throw new Error("Use connect ID --ssh HOST --session NAME [--shell posix|powershell]");
    method = "POST";
    body = JSON.stringify({
      id: args[1],
      session: flags.get("--session"),
      ssh: { host: flags.get("--ssh"), shell },
    });
  } else if (args[0] === "capacity" && args.length === 3) {
    const raw = args.at(-1)!;
    if (raw !== "--clear" && (!/^\d+$/u.test(raw) || !Number.isSafeInteger(Number(raw))))
      throw new Error("Use a nonnegative integer limit or --clear for unlimited");
    const limit = raw === "--clear" ? null : Number(raw);
    method = "POST";
    body = JSON.stringify({ action: "capacity", id: args[1], capacity: limit });
  } else if (args[0] === "workspaces" && args.length >= 3) {
    const workspaces: Array<{ kind: "repository" | "directory"; path: string }> = [];
    if (!(args.length === 3 && args[2] === "--clear")) {
      for (let index = 2; index < args.length; index += 2) {
        const kind = args[index],
          target = args[index + 1];
        // A Windows fleet's grants are drive paths on that machine (ADR 0184).
        if (!["--repo", "--dir"].includes(kind!) || !/^(?:\/|[A-Za-z]:[\\/])/u.test(target ?? ""))
          throw new Error("Use workspaces ID (--repo /checkout | --dir /directory)... or --clear");
        workspaces.push({ kind: kind === "--repo" ? "repository" : "directory", path: target! });
      }
    }
    method = "POST";
    body = JSON.stringify({ action: "workspaces", id: args[1], workspaces });
  } else if (["harnesses", "membership"].includes(args[0] ?? "") && args.length === 2) {
    path = `/v1/runtime-connections/${encodeURIComponent(args[1]!)}/${args[0]}`;
  } else if (args[0] === "prepare") {
    const usage =
      "Usage: clankie runtime prepare ID [--codex-source-setup ABSOLUTE_REMOTE_SCRIPT] [--project PROJECT] [--approve]";
    if (!args[1]) throw new Error(usage);
    const flags = new Map<string, string>();
    let approvalRequested = false;
    for (let index = 2; index < args.length; index++) {
      const flag = args[index]!;
      if (flag === "--approve" && !approvalRequested) {
        approvalRequested = true;
        continue;
      }
      if (
        !["--codex-source-setup", "--project"].includes(flag) ||
        flags.has(flag) ||
        args[index + 1] === undefined
      )
        throw new Error(usage);
      flags.set(flag, args[++index]!);
    }
    const codexSourceSetup = flags.get("--codex-source-setup");
    if (
      codexSourceSetup !== undefined &&
      (/\p{Cc}/u.test(codexSourceSetup) ||
        !(posix.isAbsolute(codexSourceSetup) || win32.isAbsolute(codexSourceSetup)))
    )
      throw new Error("Codex source setup must be an absolute script path on the remote machine");
    if (codexSourceSetup !== undefined && !approvalRequested)
      throw new Error(
        "New Codex source setup requires interactive owner approval; use --approve in an interactive terminal.",
      );
    const requestedProject = flags.get("--project");
    const contextOptions = {
      ...options,
      ...(requestedProject === undefined ? {} : { projectId: requestedProject }),
    };
    const context = await machineSetupContext(args[1], contextOptions);
    let ownerApproved = false;
    if (approvalRequested) {
      await confirmMachineSetupApproval(
        `Prepare harness bridges on machine ${context.machine.id} (${args[1]}) from ${context.workingDirectory}${context.projectId ? ` (project ${context.projectId})` : ""}.${codexSourceSetup ? ` Run and remember Codex source setup ${codexSourceSetup}.` : ""}`,
      );
      const after = await machineSetupContext(args[1], contextOptions);
      if (
        after.projectId !== context.projectId ||
        after.workingDirectory !== context.workingDirectory ||
        after.machine.id !== context.machine.id ||
        after.machine.targetRevision !== context.machine.targetRevision
      )
        throw new Error("The setup workspace, project or machine changed during approval.");
      ownerApproved = true;
    }
    if (context.effective.machineSetup === "owner" && !ownerApproved)
      throw new Error(
        "Machine setup requires owner approval; review the proposed setup and use the owner's explicit --approve.",
      );
    if (!context.machine.linked && !ownerApproved)
      throw new Error(
        "Automatic machine setup requires an already-linked machine; ask the owner to approve or connect it.",
      );
    path = `/v1/runtime-connections/${encodeURIComponent(args[1]!)}/prepare`;
    method = "POST";
    body = JSON.stringify({
      workingDirectory: context.workingDirectory,
      expectedMachineRevision: context.machine.targetRevision,
      ...(context.projectId === undefined ? {} : { projectId: context.projectId }),
      ownerApproved,
      ...(codexSourceSetup === undefined ? {} : { codexSourceSetup }),
    });
  } else if (args[0] === "disconnect" && args.length === 2) {
    method = "DELETE";
    path += `/${encodeURIComponent(args[1]!)}`;
  } else if (args.length > 1 || (args[0] && !["list", "status"].includes(args[0]))) {
    throw new Error(
      "Usage: clankie runtime [list|status] | connect ID (--session NAME | --socket PATH) | connect ID --ssh HOST --session NAME [--shell posix|powershell] | reconnect ID | disconnect ID | workspaces ID (--repo PATH | --dir PATH)... | workspaces ID --clear | capacity ID N|--clear (limits count per coordinator scope)",
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
