import { resolveCaptainCredential, type CredentialStore } from "@clankie/credential-broker";
import { text } from "node:stream/consumers";
import {
  HireReceiptIdSchema,
  OPERATOR_CONVERSATION_DISPATCH_PATH,
  OperatorConversationServiceResultSchema,
  OperatorConversationServiceRequestSchema,
} from "@clankie/protocol";
import { commandHost, outputJson, type Writable } from "./io.ts";

/** Settlement supplies identity only; fresh work is a separate explicit, UUID-bound hire. */
export async function runHireReceiptCommand(
  args: readonly string[],
  options: {
    env?: NodeJS.ProcessEnv;
    host?: string;
    fetchImpl?: typeof fetch;
    captainCredentialStore?: CredentialStore;
    stdout?: Writable;
    stdin?: AsyncIterable<Uint8Array | string>;
  } = {},
): Promise<number> {
  let request: Extract<
    import("@clankie/protocol").OperatorConversationServiceRequest,
    { op: "spawn_seat" | "settle_hire_receipt" }
  >;
  if (args.length === 2 && args[0] === "fresh" && args[1] === "--json-stdin") {
    if (!options.stdin && process.stdin.isTTY)
      throw new Error("Pipe the fresh hire request on stdin; retain its UUID for reconciliation");
    request = OperatorConversationServiceRequestSchema.parse({
      ...JSON.parse(await text(options.stdin ?? process.stdin)),
      op: "spawn_seat",
      schemaVersion: 1,
    }) as Extract<typeof request, { op: "spawn_seat" }>;
    if (!request.seat.freshIntent || !request.conversationId || !request.brief?.trim())
      throw new Error("Fresh work requires seat.freshIntent, an authorized conversationId and a new brief");
  } else {
    const disposition = args[2] ?? "not-launched";
    if (
      (args.length !== 2 && args.length !== 3) ||
      args[0] !== "settle" ||
      !HireReceiptIdSchema.safeParse(args[1]).success ||
      !["not-launched", "delivered", "abandoned", "abandoned-unknown"].includes(disposition)
    )
      throw new Error(
        "Usage: clankie hire-receipt settle ORIGINAL_ID [not-launched|delivered|abandoned|abandoned-unknown] | fresh --json-stdin",
      );
    request = {
      op: "settle_hire_receipt",
      schemaVersion: 1,
      receiptId: args[1]!,
      ...(args[2]
        ? { disposition: disposition as "not-launched" | "delivered" | "abandoned" | "abandoned-unknown" }
        : {}),
    };
  }
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
      signal: AbortSignal.timeout(request.op === "spawn_seat" ? 180_000 : 60_000),
      headers: { authorization: `Bearer ${credential.token}`, "content-type": "application/json" },
      body: JSON.stringify(request),
    },
  );
  if (!response.ok)
    throw new Error(
      `Hire receipt operation returned ${response.status}; inspect the original identity, never resend`,
    );
  const result = OperatorConversationServiceResultSchema.parse(await response.json());
  if (request.op === "spawn_seat") {
    if (result.op !== "spawn_seat") throw new Error("Unexpected fresh hire result");
    outputJson(options.stdout ?? process.stdout, result.result);
    return result.result.outcome === "spawned" ? 0 : 1;
  }
  if (result.op !== "settle_hire_receipt") throw new Error("Unexpected hire settlement result");
  outputJson(options.stdout ?? process.stdout, result.result);
  return result.result.state !== "refused" ? 0 : 1;
}
