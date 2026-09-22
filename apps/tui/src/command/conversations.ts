import { parseArgs } from "node:util";
import { resolveCaptainCredential, type CredentialStore } from "@clankie/credential-broker";
import {
  createCaptainOperatorConversationClient,
  createCaptainRouteClient,
} from "../session/operator-conversations.ts";
import { commandHost, outputJson, type Writable } from "./io.ts";

const USAGE =
  "Usage: clankie conversations list | show ID [--cursor CURSOR] [--limit N] | tail ID [--cursor CURSOR]";

/** The same discovery, replay, and live tail used by the visual conversation picker. */
export async function runConversationsCommand(
  args: readonly string[],
  options: {
    readonly env?: NodeJS.ProcessEnv;
    readonly host?: string;
    readonly fetchImpl?: typeof fetch;
    readonly captainCredentialStore?: CredentialStore;
    readonly stdout?: Writable;
    readonly signal?: AbortSignal;
  },
): Promise<number> {
  const { values, positionals } = parseArgs({
    args: [...args],
    allowPositionals: true,
    options: { cursor: { type: "string" }, limit: { type: "string", default: "100" } },
  });
  const [action = "list", selector] = positionals;
  const limit = Number(values.limit);
  if (
    !["list", "show", "tail"].includes(action) ||
    positionals.length > 2 ||
    (action === "list" ? selector !== undefined || values.cursor !== undefined : selector === undefined) ||
    !Number.isInteger(limit) ||
    limit < 1 ||
    limit > 100
  )
    throw new Error(USAGE);
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
  const stdout = options.stdout ?? process.stdout;
  const conversations = await client.list();
  if (action === "list") {
    outputJson(stdout, conversations);
    return 0;
  }
  const exact = conversations.find((item) => item.conversationId === selector);
  const matches =
    exact === undefined
      ? conversations.filter(
          (item) =>
            item.title === selector ||
            (item.scope.kind === "room" &&
              (item.scope.targetId === selector || item.scope.targetId.split(":").at(-1) === selector)),
        )
      : [exact];
  if (matches.length !== 1) throw new Error("Choose one conversation ID from clankie conversations list.");
  const conversation = matches[0]!;
  const request = {
    schemaVersion: 1 as const,
    conversationId: conversation.conversationId,
    surfaceClientId: "clankie-cli",
    limit,
    ...(values.cursor === undefined ? {} : { cursor: values.cursor }),
  };
  if (action === "show") {
    outputJson(stdout, { conversation, ...(await client.replay(request)) });
  } else {
    for await (const event of client.tail(request, options.signal)) outputJson(stdout, event);
  }
  return 0;
}
