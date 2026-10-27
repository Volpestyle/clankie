import { randomUUID } from "node:crypto";
import { resolveOperatorCredential } from "@clankie/credential-broker";
import {
  OPERATOR_SEAT_MIGRATIONS_PATH,
  OperatorSeatMigrationRequestSchema,
  OperatorSeatMigrationResultSchema,
} from "@clankie/protocol";
import { commandHost } from "./io.ts";
import type { OwnerSettingsApiOptions } from "./owner-settings-api.ts";

/** One HTTP attempt. A lost response is reconciled by the printed original ID. */
export async function seatMigrationRequest(input: unknown, options: OwnerSettingsApiOptions) {
  const body = OperatorSeatMigrationRequestSchema.parse(input);
  const env = options.env ?? process.env;
  const credential = await resolveOperatorCredential({
    env,
    ...(options.operatorCredentialStore ? { store: options.operatorCredentialStore } : {}),
  });
  if (!credential) throw Error("Operator credential required for seat migration");
  const response = await (options.fetchImpl ?? fetch)(
    new URL(OPERATOR_SEAT_MIGRATIONS_PATH, commandHost({ ...options, env })),
    {
      method: "POST",
      headers: { authorization: `Bearer ${credential.token}`, "content-type": "application/json" },
      body: JSON.stringify(body),
      redirect: "error",
      signal: AbortSignal.timeout(30_000),
    },
  );
  const result = await response.json();
  if (!response.ok)
    throw Error(
      typeof result.detail === "string"
        ? result.detail
        : "Seat migration unavailable; inspect its original ID",
    );
  return OperatorSeatMigrationResultSchema.parse(result);
}

export async function runSeatMigrationCommand(args: readonly string[], options: OwnerSettingsApiOptions) {
  if (args.length === 2 && ["status", "complete"].includes(args[0]!))
    return seatMigrationRequest({ action: args[0], id: args[1] }, options);
  if (
    (args.length === 3 || args.length === 5) &&
    args[0] === "prepare" &&
    args[1] === "--conversation" &&
    (args.length === 3 || args[3] === "--request")
  ) {
    const id = args[4] ?? randomUUID();
    process.stderr.write(
      `Seat migration ${id}; after an uncertain response use clankie seat migrate status ${id}.\n`,
    );
    return seatMigrationRequest({ action: "prepare", id, conversationId: args[2] }, options);
  }
  throw Error(
    "Usage: clankie seat migrate prepare --conversation ID [--request UUID] | status UUID | complete UUID",
  );
}
