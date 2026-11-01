import { resolveOperatorCredential, type CredentialStore } from "@clankie/credential-broker";
import { EXTENSIONS_PATH, ExtensionStatesSchema, type ExtensionStates } from "@clankie/protocol";
import { commandHost } from "./io.ts";

export interface ExtensionsCommandOptions {
  readonly env?: NodeJS.ProcessEnv;
  readonly host?: string;
  readonly fetchImpl?: typeof fetch;
  readonly operatorCredentialStore?: CredentialStore;
}

/** Each extension's state after a fresh health read (ADR 0328). */
export async function runExtensionsCommand(
  args: readonly string[],
  options: ExtensionsCommandOptions = {},
): Promise<ExtensionStates> {
  if (args.length > 1 || (args[0] !== undefined && args[0] !== "status"))
    throw new Error("Usage: clankie extensions [status]");
  const credential = await resolveOperatorCredential({
    env: options.env ?? process.env,
    ...(options.operatorCredentialStore === undefined ? {} : { store: options.operatorCredentialStore }),
  });
  if (!credential) throw new Error("Operator credential unavailable; run clankie doctor.");
  const response = await (options.fetchImpl ?? fetch)(
    `${commandHost(options).replace(/\/+$/u, "")}${EXTENSIONS_PATH}`,
    { headers: { authorization: `Bearer ${credential.token}` }, signal: AbortSignal.timeout(5000) },
  );
  if (!response.ok) throw new Error(`Extensions unavailable (${response.status}); run clankie doctor.`);
  return ExtensionStatesSchema.parse(await response.json());
}
