import { parseArgs } from "node:util";
import { resolveCaptainCredential, type CredentialStore } from "@clankie/credential-broker";
import {
  createCaptainOperatorConversationClient,
  createCaptainRouteClient,
} from "../session/operator-conversations.ts";
import { commandHost, outputJson, type Writable } from "./io.ts";

/** A reset is explicit, scoped to one conversation, and guarded against stale reads. */
export async function runResetCommand(
  args: readonly string[],
  options: {
    readonly env?: NodeJS.ProcessEnv;
    readonly host?: string;
    readonly fetchImpl?: typeof fetch;
    readonly captainCredentialStore?: CredentialStore;
    readonly stdout?: Writable;
  },
): Promise<number> {
  const { values } = parseArgs({ args: [...args], options: { conversation: { type: "string" } } });
  const id = values.conversation;
  if (id === undefined || id.trim().length === 0) throw new Error("Usage: clankie reset --conversation ID");
  const env = options.env ?? process.env;
  const credential = await resolveCaptainCredential({
    env,
    ...(options.captainCredentialStore === undefined ? {} : { store: options.captainCredentialStore }),
  });
  if (credential === undefined) throw new Error("No captain credential is available; start Clankie first.");
  const client = createCaptainOperatorConversationClient(
    createCaptainRouteClient({
      host: commandHost({ ...options, env }),
      captainToken: credential.token,
      ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
    }),
  );
  const conversation = await client.get(id);
  if (conversation === undefined || client.reset === undefined)
    throw new Error("Conversation reset is unavailable");
  const result = await client.reset(id, conversation.revision);
  outputJson(options.stdout ?? process.stdout, { ok: true, ...result });
  return 0;
}
