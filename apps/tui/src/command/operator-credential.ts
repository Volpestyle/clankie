import {
  protectOperatorCredential,
  protectedKeychainPath,
  rotateOperatorCredential,
  type CredentialStore,
} from "@clankie/credential-broker";
import { outputJson, type Writable } from "./io.ts";

const OPERATOR_CREDENTIAL_USAGE = "Usage: clankie operator-credential rotate|protect [--json]";

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
  const action = args[0];
  if ((action !== "rotate" && action !== "protect") || args.slice(1).some((arg) => arg !== "--json")) {
    throw new Error(OPERATOR_CREDENTIAL_USAGE);
  }
  if (action === "protect") {
    const env = options.env ?? process.env;
    const result = await protectOperatorCredential({ env });
    const output = options.stdout ?? process.stdout;
    if (json)
      outputJson(output, { ok: true, status: result.moved ? "protected" : "already_protected", ...result });
    else
      output.write(
        result.moved
          ? `Operator credential moved to ${protectedKeychainPath(env)}; the login-keychain copy is deleted. Hired workers under the worker sandbox can't read it.\n`
          : "Operator credential is already in the protected keychain.\n",
      );
    return 0;
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
