import { rotateOperatorCredential, type CredentialStore } from "@clankie/credential-broker";
import { outputJson, type Writable } from "./io.ts";

const OPERATOR_CREDENTIAL_USAGE = "Usage: clankie operator-credential rotate [--json]";

export interface OperatorCredentialCommandOptions {
  readonly env?: NodeJS.ProcessEnv;
  readonly operatorCredentialStore?: CredentialStore;
  readonly stdout?: Writable;
}

export async function runOperatorCredentialCommand(
  args: readonly string[],
  options: OperatorCredentialCommandOptions,
): Promise<number> {
  const json = args.includes("--json");
  if (args[0] !== "rotate" || args.some((arg) => arg !== "rotate" && arg !== "--json")) {
    throw new Error(OPERATOR_CREDENTIAL_USAGE);
  }
  const credential = await rotateOperatorCredential({
    env: options.env ?? process.env,
    ...(options.operatorCredentialStore === undefined ? {} : { store: options.operatorCredentialStore }),
  });
  const output = options.stdout ?? process.stdout;
  if (json) outputJson(output, { ok: true, status: "rotated", source: credential.source });
  else output.write("Operator credential rotated. Existing operator sessions are invalidated.\n");
  return 0;
}
