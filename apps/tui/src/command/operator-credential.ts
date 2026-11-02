import {
  protectOperatorCredential,
  protectStoredCredentials,
  protectedKeychainPath,
  rotateOperatorCredential,
  type CredentialStore,
} from "@clankie/credential-broker";
import { outputJson, type Writable } from "./io.ts";

const OPERATOR_CREDENTIAL_USAGE = "Usage: clankie operator-credential rotate|protect [--json]";
// `protect` moves the operator credential and every other Clankie bearer
// (captain, bridges, joined hosts, gateway) into the protected keychain.

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
    // Then every other bearer that grants authority over Clankie: the captain's, the
    // bridges', joined hosts' and the gateway's. Ids only are reported, never values.
    const others = await protectStoredCredentials({ env });
    const output = options.stdout ?? process.stdout;
    if (json)
      outputJson(output, {
        ok: others.failed.length === 0,
        status: result.moved || others.moved.length > 0 ? "protected" : "already_protected",
        ...result,
        credentials: { moved: others.moved, failed: others.failed },
      });
    else {
      output.write(
        result.moved
          ? `Operator credential moved to ${protectedKeychainPath(env)}; the login-keychain copy is deleted. Hired workers under the worker sandbox can't read it.\n`
          : "Operator credential is already in the protected keychain.\n",
      );
      if (others.moved.length > 0)
        output.write(`Also moved to the protected keychain: ${others.moved.join(", ")}.\n`);
      if (others.failed.length > 0)
        output.write(
          `Did not read back, so their login-keychain copies are kept: ${others.failed.join(", ")}. Run this again.\n`,
        );
    }
    return others.failed.length === 0 ? 0 : 1;
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
