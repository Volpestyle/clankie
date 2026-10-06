import { resolveCaptainCredential, type CredentialStore } from "@clankie/credential-broker";
import {
  HireReceiptIdSchema,
  OPERATOR_CONVERSATION_DISPATCH_PATH,
  OperatorConversationServiceResultSchema,
} from "@clankie/protocol";
import { commandHost, outputJson, type Writable } from "./io.ts";

/** Operator-only recovery. No request can supply a census, path, PID or replacement hire. */
export async function runHireReceiptCommand(
  args: readonly string[],
  options: {
    env?: NodeJS.ProcessEnv;
    host?: string;
    fetchImpl?: typeof fetch;
    captainCredentialStore?: CredentialStore;
    stdout?: Writable;
  } = {},
): Promise<number> {
  const disposition = args[2] ?? "not-launched";
  if (
    (args.length !== 2 && args.length !== 3) ||
    args[0] !== "settle" ||
    !HireReceiptIdSchema.safeParse(args[1]).success ||
    !["not-launched", "delivered", "abandoned"].includes(disposition)
  )
    throw new Error("Usage: clankie hire-receipt settle ORIGINAL_ID [not-launched|delivered|abandoned]");
  const env = options.env ?? process.env;
  const credential = await resolveCaptainCredential({
    env,
    ...(options.captainCredentialStore ? { store: options.captainCredentialStore } : {}),
  });
  if (!credential) throw new Error("Captain operator credential is unavailable");
  const response = await (options.fetchImpl ?? fetch)(
    new URL(OPERATOR_CONVERSATION_DISPATCH_PATH, commandHost({ ...options, env })),
    {
      method: "POST",
      redirect: "error",
      signal: AbortSignal.timeout(60_000),
      headers: { authorization: `Bearer ${credential.token}`, "content-type": "application/json" },
      body: JSON.stringify({
        op: "settle_hire_receipt",
        schemaVersion: 1,
        receiptId: args[1],
        ...(args[2] ? { disposition } : {}),
      }),
    },
  );
  if (!response.ok)
    throw new Error(`Hire settlement returned ${response.status}; inspect original receipt, never resend`);
  const result = OperatorConversationServiceResultSchema.parse(await response.json());
  if (result.op !== "settle_hire_receipt") throw new Error("Unexpected hire settlement result");
  outputJson(options.stdout ?? process.stdout, result.result);
  return result.result.state !== "refused" ? 0 : 1;
}
