import { resolveCaptainCredential, type CredentialStore } from "@clankie/credential-broker";
import {
  OPERATOR_CONVERSATION_DISPATCH_PATH,
  OperatorConversationServiceResultSchema,
  type OperatorConversationServiceRequest,
  type UnresolvedSeatDelivery,
  type OperatorSeatBridgeStatus,
} from "@clankie/protocol";
import { commandHost, outputJson, type Writable } from "./io.ts";

const USAGE =
  "Usage: clankie seat-delivery list | settle RECEIPT_ID abandoned-unknown [--conversation CONVERSATION_ID]";

/**
 * Unresolved head seat deliveries (VUH-1779). `list` reads them with their age;
 * `settle` is the owner's explicit `abandoned-unknown` record: it never claims
 * receipt and never resends the original.
 */
export async function runSeatDeliveryCommand(
  args: readonly string[],
  options: {
    env?: NodeJS.ProcessEnv;
    host?: string;
    fetchImpl?: typeof fetch;
    captainCredentialStore?: CredentialStore;
    stdout?: Writable;
  } = {},
): Promise<number> {
  let request: SeatDeliveryRequest;
  if (args.length === 1 && args[0] === "list") request = { op: "seat_deliveries", schemaVersion: 1 };
  else if (
    args[0] === "settle" &&
    args[1] !== undefined &&
    !args[1].startsWith("-") &&
    args[2] === "abandoned-unknown" &&
    (args.length === 3 || (args.length === 5 && args[3] === "--conversation" && args[4]))
  )
    request = {
      op: "settle_seat_delivery",
      schemaVersion: 1,
      conversationId: args[4] ?? "global-default",
      receiptId: args[1],
      disposition: "abandoned-unknown",
    };
  else throw new Error(USAGE);
  const result = await post(request, options);
  if (result.op === "seat_deliveries" && request.op === "seat_deliveries") {
    outputJson(options.stdout ?? process.stdout, { unresolved: result.unresolved });
    return 0;
  }
  if (result.op !== "settle_seat_delivery" || request.op !== "settle_seat_delivery")
    throw new Error("Unexpected seat delivery result");
  outputJson(options.stdout ?? process.stdout, result.result);
  return result.result.state === "refused" ? 1 : 0;
}

type SeatDeliveryRequest = Extract<
  OperatorConversationServiceRequest,
  { op: "seat_deliveries" | "settle_seat_delivery" | "seat_bridges" }
>;
type SeatDeliveryOptions = Parameters<typeof runSeatDeliveryCommand>[1] & { timeoutMs?: number };

/** Loaded receiver capabilities, including legacy bridges retained across a deploy. */
export async function readSeatBridges(options: SeatDeliveryOptions): Promise<OperatorSeatBridgeStatus[]> {
  const result = await post({ op: "seat_bridges", schemaVersion: 1 }, options);
  if (result.op !== "seat_bridges") throw new Error("Unexpected seat bridge result");
  return result.bridges;
}

/** Doctor's read: unresolved head deliveries with their age. */
export async function readSeatDeliveries(options: SeatDeliveryOptions): Promise<UnresolvedSeatDelivery[]> {
  const result = await post({ op: "seat_deliveries", schemaVersion: 1 }, options);
  if (result.op !== "seat_deliveries") throw new Error("Unexpected seat delivery result");
  return result.unresolved;
}

async function post(request: SeatDeliveryRequest, options: SeatDeliveryOptions) {
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
      signal: AbortSignal.timeout(options.timeoutMs ?? 30_000),
      headers: { authorization: `Bearer ${credential.token}`, "content-type": "application/json" },
      body: JSON.stringify(request),
    },
  );
  if (!response.ok)
    throw new Error(
      `Seat delivery operation returned ${response.status}; inspect with \`clankie seat-delivery list\`, never resend`,
    );
  return OperatorConversationServiceResultSchema.parse(await response.json());
}

/** Human age for doctor and the CLI; legacy receipts have no recorded start. */
export function formatSeatDeliveryAge(ageMs: number | undefined): string {
  if (ageMs === undefined) return "age unknown";
  const minutes = Math.floor(ageMs / 60_000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return hours < 48 ? `${hours}h ${minutes % 60}m` : `${Math.floor(hours / 24)}d ${hours % 24}h`;
}
