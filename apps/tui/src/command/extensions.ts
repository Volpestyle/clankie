import { resolveOperatorCredential, type CredentialStore } from "@clankie/credential-broker";
import {
  EXTENSIONS_PATH,
  ExtensionStatesSchema,
  UpdateExtensionSchema,
  type ExtensionStates,
  type UpdateExtension,
} from "@clankie/protocol";
import { commandHost } from "./io.ts";

export interface ExtensionsCommandOptions {
  readonly env?: NodeJS.ProcessEnv;
  readonly host?: string;
  readonly fetchImpl?: typeof fetch;
  readonly operatorCredentialStore?: CredentialStore;
}

const USAGE = "Usage: clankie extensions [status] | on ID | off ID";

/**
 * Each extension's state after a fresh health read, and the owner's switches
 * (ADR 0328). `on`/`off` change one switch; it takes effect at the next start.
 */
export async function runExtensionsCommand(
  args: readonly string[],
  options: ExtensionsCommandOptions = {},
): Promise<ExtensionStates> {
  const verb = args[0] ?? "status";
  let change: UpdateExtension | undefined;
  if (verb === "on" || verb === "off") {
    const parsed = UpdateExtensionSchema.safeParse({ schemaVersion: 1, id: args[1], switch: verb });
    if (args.length !== 2 || !parsed.success) throw new Error(USAGE);
    change = parsed.data;
  } else if (verb !== "status" || args.length > 1) throw new Error(USAGE);
  const credential = await resolveOperatorCredential({
    env: options.env ?? process.env,
    ...(options.operatorCredentialStore === undefined ? {} : { store: options.operatorCredentialStore }),
  });
  if (!credential) throw new Error("Operator credential unavailable; run clankie doctor.");
  const response = await (options.fetchImpl ?? fetch)(
    `${commandHost(options).replace(/\/+$/u, "")}${EXTENSIONS_PATH}`,
    {
      method: change === undefined ? "GET" : "POST",
      headers: {
        authorization: `Bearer ${credential.token}`,
        ...(change === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(change === undefined ? {} : { body: JSON.stringify(change) }),
      signal: AbortSignal.timeout(5000),
    },
  );
  if (response.status === 404 && change !== undefined)
    throw new Error(`No extension named ${change.id}; run clankie extensions for the list.`);
  if (!response.ok) throw new Error(`Extensions unavailable (${response.status}); run clankie doctor.`);
  return ExtensionStatesSchema.parse(await response.json());
}
