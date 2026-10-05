import { parseArgs } from "node:util";
import { ClankieApiClient } from "@clankie/api-client";
import { resolveOperatorCredential, type CredentialStore } from "@clankie/credential-broker";
import { SupportGrantCreateRequestSchema, SupportGrantIdSchema } from "@clankie/protocol/support-access";
import { commandHost, outputJson, type Writable } from "./io.ts";

const USAGE =
  "Usage: clankie support [list | create read-state|shell --hours 1..72 --ref REFERENCE | revoke ID | offer ID]";

/** Owner-authenticated lifecycle; the ambient captain bearer cannot issue support access. */
export async function runSupportCommand(
  args: readonly string[],
  options: {
    readonly env?: NodeJS.ProcessEnv;
    readonly host?: string;
    readonly fetchImpl?: typeof fetch;
    readonly operatorCredentialStore?: CredentialStore;
    readonly stdout?: Writable;
  },
): Promise<number> {
  const { values, positionals } = parseArgs({
    args: [...args],
    allowPositionals: true,
    options: { hours: { type: "string" }, ref: { type: "string" } },
  });
  const [action = "list", selector, ...extra] = positionals;
  if (
    extra.length ||
    !["list", "create", "revoke", "offer"].includes(action) ||
    (action === "list" ? selector !== undefined : selector === undefined) ||
    (action !== "create" && (values.hours !== undefined || values.ref !== undefined))
  )
    throw new Error(USAGE);
  const hours = Number(values.hours ?? "24");
  if (action === "create" && (!Number.isInteger(hours) || hours < 1 || hours > 72)) throw new Error(USAGE);
  const create =
    action === "create"
      ? SupportGrantCreateRequestSchema.parse({
          scope: selector,
          durationSeconds: hours * 3600,
          supportRef: values.ref,
        })
      : undefined;
  if (action === "revoke" || action === "offer") SupportGrantIdSchema.parse(selector);
  const env = options.env ?? process.env;
  const credential = await resolveOperatorCredential({
    env,
    ...(options.operatorCredentialStore === undefined ? {} : { store: options.operatorCredentialStore }),
  });
  if (credential === undefined) throw new Error("Owner credential required to manage support access.");
  const client = new ClankieApiClient({
    baseUrl: commandHost({ ...options, env }),
    operatorToken: credential.token,
    ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
  });
  const result =
    action === "create"
      ? await client.createSupportGrant(create!)
      : action === "revoke"
        ? await client.revokeSupportGrant(selector!)
        : action === "offer"
          ? await client.createSupportPairingOffer(selector!)
          : await client.listSupportGrants();
  outputJson(options.stdout ?? process.stdout, result);
  return 0;
}
