import { text } from "node:stream/consumers";
import { parseArgs } from "node:util";
import { resolveCaptainCredential, type CredentialStore } from "@clankie/credential-broker";
import { SubmitOperatorConversationTurnSchema } from "@clankie/protocol";
import {
  createCaptainOperatorConversationClient,
  createCaptainRouteClient,
} from "../session/operator-conversations.ts";
import { commandHost, outputJson, type Writable } from "./io.ts";

const USAGE = "Usage: clankie send --conversation ID [--delivery steer|queue] (MESSAGE | --stdin)";

/** Submit without waiting for a reply; every surface observes the same accepted run. */
export async function runSendCommand(
  args: readonly string[],
  options: {
    readonly env?: NodeJS.ProcessEnv;
    readonly host?: string;
    readonly fetchImpl?: typeof fetch;
    readonly captainCredentialStore?: CredentialStore;
    readonly stdout?: Writable;
    readonly stdin?: Parameters<typeof text>[0];
  },
): Promise<number> {
  const { values, positionals } = parseArgs({
    args: [...args],
    allowPositionals: true,
    options: {
      conversation: { type: "string" },
      delivery: { type: "string", default: "steer" },
      stdin: { type: "boolean" },
    },
  });
  if (values.stdin === true && positionals.length > 0)
    throw new Error(`Pass MESSAGE or --stdin, not both. ${USAGE}`);
  const message = values.stdin === true ? await text(options.stdin ?? process.stdin) : positionals.join(" ");
  const parsed = SubmitOperatorConversationTurnSchema.safeParse({
    schemaVersion: 1,
    kind: "message",
    conversationId: values.conversation,
    surfaceClientId: "clankie-cli",
    expectedRevision: 0,
    message,
    delivery: values.delivery,
  });
  if (!parsed.success) throw new Error(USAGE);
  const env = options.env ?? process.env;
  const credential = await resolveCaptainCredential({
    env,
    ...(options.captainCredentialStore === undefined ? {} : { store: options.captainCredentialStore }),
  });
  if (credential === undefined)
    throw new Error("No captain credential is available; start the clankie service once first.");
  const client = createCaptainOperatorConversationClient(
    createCaptainRouteClient({
      host: commandHost({ ...options, env }),
      captainToken: credential.token,
      ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
    }),
  );
  const conversation = await client.get(parsed.data.conversationId);
  if (conversation === undefined) throw new Error("That conversation does not exist");
  const result = await client.send({ ...parsed.data, expectedRevision: conversation.revision });
  outputJson(options.stdout ?? process.stdout, result);
  return result.status === "accepted" ? 0 : 1;
}
