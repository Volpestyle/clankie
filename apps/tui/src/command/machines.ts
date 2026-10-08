import { resolveOperatorCredential, type CredentialStore } from "@clankie/credential-broker";
import { MachineAccessChangeSchema, MachineInventorySchema, type MachineInventory } from "@clankie/protocol";
import { commandHost } from "./io.ts";
import { runRuntimeCommand } from "./runtime.ts";
import { dirname, join } from "node:path";
import {
  defaultSettingsPath,
  localSandboxControl,
  prepareLocalSandbox,
  readLocalSandbox,
  removeLocalSandbox,
} from "@clankie/settings";

const MACHINES_USAGE =
  "Usage: clankie machines [list|discover] [--json]\n       clankie machines add NAME --ssh HOST [--shell posix|powershell]\n       clankie machines access NAME portal|workers|shell|screen\n       clankie machines sandbox status|remove\n       clankie machines sandbox prepare portal|workers|shell --workspace DIR [--workspace DIR] [--home DIR]\n       clankie machines remove NAME\n       clankie machines sessions NAME [--connect SESSION --id CONNECTION] [--json]";
export const MACHINE_RESTART_HINT =
  "Named machine connections apply immediately. Default workspace changes require clankie restart captain.";
export async function runMachinesCommand(
  args: readonly string[],
  options: {
    env?: NodeJS.ProcessEnv;
    host?: string;
    fetchImpl?: typeof fetch;
    operatorCredentialStore?: CredentialStore;
    repoRoot?: string;
  } = {},
): Promise<unknown> {
  const values = args.filter((arg) => arg !== "--json");
  const [verb = "list", name, ...rest] = values;
  if (verb === "sandbox") {
    const env = options.env ?? process.env;
    const control = localSandboxControl(env);
    if (name === "status" && !rest.length) {
      const envelope = await readLocalSandbox(control);
      return {
        control,
        state: envelope ? "prepared" : "unrestricted",
        envelope,
        detail:
          "Launch controls only; clankie machines list reports the running service's verified enforcement.",
      };
    }
    if (name === "remove" && !rest.length) {
      await removeLocalSandbox(control);
      return {
        state: "unrestricted-next-launch",
        detail:
          "No running process changed. Owner stop/start is required; private home and workspace data were kept.",
      };
    }
    if (name !== "prepare" || !options.repoRoot) throw new Error(MACHINES_USAGE);
    const accessLevel = MachineAccessChangeSchema.parse({ accessLevel: rest[0] }).accessLevel;
    const workspaces: string[] = [];
    let home = join(dirname(control), "local-sandbox-home");
    let homeSet = false;
    for (let i = 1; i < rest.length; i += 2) {
      if (!rest[i + 1]) throw new Error(MACHINES_USAGE);
      if (rest[i] === "--workspace") workspaces.push(rest[i + 1]!);
      else if (rest[i] === "--home" && !homeSet) {
        home = rest[i + 1]!;
        homeSet = true;
      } else throw new Error(MACHINES_USAGE);
    }
    const envelope = await prepareLocalSandbox({
      control,
      runtimeRoot: options.repoRoot,
      home,
      workspaces,
      accessLevel,
      settingsPath: defaultSettingsPath(env),
    });
    return {
      state: "prepared-next-launch",
      control,
      envelope,
      detail:
        "No running process changed. Provision this private home, then owner stop/start; unrestricted existing workers remain unrestricted.",
    };
  }
  let path = "/v1/machines",
    method = "GET",
    body: string | undefined;
  if (verb === "discover" && values.length === 1) path += "?discover=true";
  else if (verb === "access" && name && rest.length === 1) {
    body = JSON.stringify(MachineAccessChangeSchema.parse({ accessLevel: rest[0] }));
    method = "PATCH";
    path += `/${encodeURIComponent(name)}/access`;
  } else if (verb === "add" && name) {
    const flags = new Map<string, string>();
    for (let i = 0; i < rest.length; i += 2) {
      if (!["--ssh", "--shell"].includes(rest[i]!) || !rest[i + 1] || flags.has(rest[i]!))
        throw new Error(MACHINES_USAGE);
      flags.set(rest[i]!, rest[i + 1]!);
    }
    if (!flags.has("--ssh")) throw new Error(MACHINES_USAGE);
    method = "POST";
    body = JSON.stringify({ id: name, ssh: flags.get("--ssh"), shell: flags.get("--shell") ?? "posix" });
  } else if (verb === "remove" && name && values.length === 2) {
    method = "DELETE";
    path += `/${encodeURIComponent(name)}`;
  } else if (
    verb === "sessions" &&
    name &&
    (rest.length === 0 || (rest.length === 4 && rest[0] === "--connect" && rest[2] === "--id"))
  ) {
    if (rest.length) return runRuntimeCommand(["connect-machine", rest[3]!, name, rest[1]!], options);
  } else if (!(verb === "list" && values.length <= 1)) throw new Error(MACHINES_USAGE);
  const credential = await resolveOperatorCredential({
    env: options.env ?? process.env,
    ...(options.operatorCredentialStore ? { store: options.operatorCredentialStore } : {}),
  });
  if (!credential) throw new Error("Machines need the operator credential");
  const response = await (options.fetchImpl ?? fetch)(`${commandHost(options)}${path}`, {
    method,
    headers: { authorization: `Bearer ${credential.token}`, "content-type": "application/json" },
    ...(body ? { body } : {}),
    signal: AbortSignal.timeout(15_000),
  });
  const result = (await response.json()) as Record<string, unknown>;
  if (!response.ok)
    throw new Error(typeof result.detail === "string" ? result.detail : `Machines: ${response.status}`);
  if (verb === "sessions") {
    const inventory = MachineInventorySchema.parse(result);
    const machine = inventory.machines.find((entry) => entry.id === name);
    if (!machine) throw new Error(`Unknown machine ${name}`);
    return { ...inventory, machines: [machine] };
  }
  return result;
}
export function formatMachines(inventory: MachineInventory): string {
  return [
    "MACHINE  ACCESS  HERDR SESSION  STATE  WORKERS",
    ...inventory.machines.map(
      (machine) =>
        `${machine.id}${machine.configured ? "" : " (candidate)"}  ${machine.accessLevel ?? "unreported"}${machine.accessEnforcement ? ` (${machine.accessEnforcement}${machine.accessCeiling ? `, ceiling ${machine.accessCeiling}` : ""})` : ""}  ${machine.sessions.map((session) => session.name).join(", ") || "—"}  ${machine.state}  ${machine.workerCount ?? "?"}`,
    ),
    MACHINE_RESTART_HINT,
  ].join("\n");
}
