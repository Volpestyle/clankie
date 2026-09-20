import { parseArgs } from "node:util";
import { resolveCaptainCredential, type CredentialStore } from "@clankie/credential-broker";
import {
  createCaptainOperatorConversationClient,
  createCaptainRouteClient,
} from "../session/operator-conversations.ts";
import { commandHost, outputJson, type Writable } from "./io.ts";

const USAGE = "Usage: clankie file publish --conversation ID PATH [--name FILENAME] [--type MEDIA_TYPE]";

export async function runFileCommand(
  args: readonly string[],
  options: {
    readonly env?: NodeJS.ProcessEnv;
    readonly host?: string;
    readonly fetchImpl?: typeof fetch;
    readonly captainCredentialStore?: CredentialStore;
    readonly stdout?: Writable;
  },
): Promise<number> {
  if (args[0] !== "publish") throw new Error(USAGE);
  const { values, positionals } = parseArgs({
    args: args.slice(1),
    allowPositionals: true,
    options: {
      conversation: { type: "string" },
      name: { type: "string" },
      type: { type: "string" },
    },
  });
  if (values.conversation === undefined || positionals.length !== 1) throw new Error(USAGE);
  const env = options.env ?? process.env;
  const credential = await resolveCaptainCredential({
    env,
    ...(options.captainCredentialStore === undefined ? {} : { store: options.captainCredentialStore }),
  });
  if (credential === undefined) {
    throw new Error("No captain credential is available; start the clankie service once first.");
  }
  const client = createCaptainOperatorConversationClient(
    createCaptainRouteClient({
      host: commandHost({ ...options, env }),
      captainToken: credential.token,
      ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
    }),
  );
  if (client.publishFile === undefined) throw new Error("This Clankie build cannot publish files");
  const file = await client.publishFile({
    conversationId: values.conversation,
    path: positionals[0]!,
    ...(values.name === undefined ? {} : { filename: values.name }),
    ...(values.type === undefined ? {} : { mediaType: values.type }),
  });
  outputJson(options.stdout ?? process.stdout, file);
  return 0;
}
