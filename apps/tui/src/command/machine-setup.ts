import { realpath } from "node:fs/promises";
import { createInterface } from "node:readline/promises";
import { resolveOperatorCredential, type CredentialStore } from "@clankie/credential-broker";
import { FleetSettingsContextSchema } from "@clankie/protocol";
import { commandHost } from "./io.ts";

/** A CLI flag is a request to ask the terminal owner, never proof of human consent. */
export async function confirmMachineSetupApproval(detail: string): Promise<void> {
  if (process.stdin.isTTY !== true || process.stdout.isTTY !== true)
    throw new Error(
      "Owner approval requires an interactive TTY confirmation; headless --approve is refused. No changes made.",
    );
  const terminal = createInterface({ input: process.stdin, output: process.stdout });
  try {
    if (!/^y(?:es)?$/iu.test((await terminal.question(`${detail}\nProceed? [y/N] `)).trim()))
      throw new Error("Machine setup was not approved. No changes made.");
  } finally {
    terminal.close();
  }
}

/** Read current server policy and existing link; this creates no workspace, account or machine grant. */
export async function machineSetupContext(
  machine: string,
  options: {
    env?: NodeJS.ProcessEnv;
    host?: string;
    fetchImpl?: typeof fetch;
    operatorCredentialStore?: CredentialStore;
    cwd?: string;
    projectId?: string;
  } = {},
) {
  const workingDirectory = await realpath(options.cwd ?? process.cwd());
  const credential = await resolveOperatorCredential({
    env: options.env ?? process.env,
    ...(options.operatorCredentialStore ? { store: options.operatorCredentialStore } : {}),
  });
  if (!credential) throw new Error("Machine setup policy needs the operator credential");
  const url = new URL("/v1/operator/fleet-settings/context", commandHost(options));
  url.searchParams.set("workingDirectory", workingDirectory);
  url.searchParams.set("machine", machine);
  if (options.projectId !== undefined) url.searchParams.set("projectId", options.projectId);
  const response = await (options.fetchImpl ?? fetch)(url, {
    headers: { authorization: `Bearer ${credential.token}` },
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok)
    throw new Error(
      `Machine setup context refused (${response.status}); inspect the current project and machine before proceeding.`,
    );
  const text = await response.text();
  if (Buffer.byteLength(text) > 16 * 1024) throw new Error("Machine setup context is too large");
  const context = FleetSettingsContextSchema.parse(JSON.parse(text));
  if (options.projectId !== undefined && options.projectId !== context.projectId)
    throw new Error("The requested setup project does not match the current workspace.");
  if ((await realpath(options.cwd ?? process.cwd())) !== workingDirectory)
    throw new Error("Machine setup workspace changed; review it before proceeding.");
  return { ...context, workingDirectory };
}
