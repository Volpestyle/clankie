import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { basename, extname } from "node:path";
import { text } from "node:stream/consumers";
import { parseArgs } from "node:util";
import {
  resolveCaptainCredential,
  resolveOperatorCredential,
  type CredentialStore,
} from "@clankie/credential-broker";
import {
  OPERATOR_CONVERSATION_ATTACHMENTS_MAX,
  operatorAttachmentBytesMax,
  SubmitOperatorConversationTurnSchema,
  type OperatorAttachmentMediaType,
  type OperatorConversationAttachmentRef,
} from "@clankie/protocol";
import {
  createCaptainOperatorConversationClient,
  createCaptainRouteClient,
} from "../session/operator-conversations.ts";
import { commandHost, outputJson, type Writable } from "./io.ts";

const USAGE =
  "Usage: clankie send --conversation ID [--delivery steer|queue] [--attach PATH]... (MESSAGE | --stdin)";

const ATTACHMENT_TYPES: Readonly<Record<string, OperatorAttachmentMediaType>> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".heic": "image/heic",
  ".heif": "image/heif",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".mp4": "video/mp4",
  ".m4v": "video/mp4",
  ".mov": "video/quicktime",
};

/** Submit without waiting for a reply; every surface observes the same accepted run. */
export async function runSendCommand(
  args: readonly string[],
  options: {
    readonly env?: NodeJS.ProcessEnv;
    readonly host?: string;
    readonly fetchImpl?: typeof fetch;
    readonly captainCredentialStore?: CredentialStore;
    readonly operatorCredentialStore?: CredentialStore;
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
      attach: { type: "string", multiple: true },
    },
  });
  if (values.stdin === true && positionals.length > 0)
    throw new Error(`Pass MESSAGE or --stdin, not both. ${USAGE}`);
  const message = values.stdin === true ? await text(options.stdin ?? process.stdin) : positionals.join(" ");
  const paths = values.attach ?? [];
  if (paths.length > OPERATOR_CONVERSATION_ATTACHMENTS_MAX)
    throw new Error(`At most ${String(OPERATOR_CONVERSATION_ATTACHMENTS_MAX)} attachments per message.`);
  // Read and check every file before anything is uploaded or sent.
  const files = await Promise.all(paths.map((path) => attachmentFile(path)));
  const parsed = SubmitOperatorConversationTurnSchema.safeParse({
    schemaVersion: 1,
    kind: "message",
    conversationId: values.conversation,
    surfaceClientId: "clankie-cli",
    expectedRevision: 0,
    message,
    delivery: values.delivery,
    // Validated with stand-in references; the real ones exist only after upload.
    ...(files.length === 0
      ? {}
      : { attachments: files.map((_, index) => ({ artifactId: String(index).padStart(48, "0") })) }),
  });
  if (!parsed.success) throw new Error(USAGE);
  const env = options.env ?? process.env;
  const credential = await resolveCaptainCredential({
    env,
    ...(options.captainCredentialStore === undefined ? {} : { store: options.captainCredentialStore }),
  });
  if (credential === undefined)
    throw new Error("No captain credential is available; start the clankie service once first.");
  // An explicit captain-only invocation stays in that lane. Normal local CLI
  // sends can use the brokered owner credential, like the interactive console.
  const operator =
    !env.CLANKIE_CAPTAIN_TOKEN || env.CLANKIE_OPERATOR_TOKEN || options.operatorCredentialStore
      ? await resolveOperatorCredential({
          env,
          ...(options.operatorCredentialStore === undefined
            ? {}
            : { store: options.operatorCredentialStore }),
        })
      : undefined;
  const client = createCaptainOperatorConversationClient(
    createCaptainRouteClient({
      host: commandHost({ ...options, env }),
      captainToken: credential.token,
      ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
    }),
    operator
      ? createCaptainRouteClient({
          host: commandHost({ ...options, env }),
          captainToken: operator.token,
          ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
        })
      : undefined,
  );
  const attachments: OperatorConversationAttachmentRef[] = [];
  for (const file of files) {
    if (client.uploadAttachment === undefined)
      throw new Error("This Clankie build cannot upload attachments");
    const uploaded = await client.uploadAttachment({ conversationId: parsed.data.conversationId, ...file });
    if (uploaded.status !== "committed")
      throw new Error(
        `Could not attach ${file.filename}: ${uploaded.status === "refused" ? uploaded.message : "upload incomplete"}`,
      );
    attachments.push({ artifactId: uploaded.file.artifactId });
  }
  // Read the revision after uploading, so a long video does not make it stale.
  const conversation = await client.get(parsed.data.conversationId);
  if (conversation === undefined) throw new Error("That conversation does not exist");
  const result = await client.send({
    ...parsed.data,
    expectedRevision: conversation.revision,
    ...(attachments.length === 0 ? {} : { attachments }),
  });
  outputJson(options.stdout ?? process.stdout, result);
  return result.status === "accepted" ? 0 : 1;
}

async function attachmentFile(path: string) {
  const mediaType = ATTACHMENT_TYPES[extname(path).toLowerCase()];
  if (mediaType === undefined)
    throw new Error(`${basename(path)}: attach png, jpeg, heic, gif, webp, mp4 or mov files.`);
  const info = await stat(path);
  if (!info.isFile()) throw new Error(`${basename(path)} is not a regular file.`);
  if (info.size === 0 || info.size > operatorAttachmentBytesMax(mediaType))
    throw new Error(
      `${basename(path)}: ${mediaType.startsWith("video/") ? "videos" : "images"} must be 1 byte to ${String(operatorAttachmentBytesMax(mediaType) / (1024 * 1024))} MiB.`,
    );
  const bytes = new Uint8Array(await readFile(path));
  return {
    filename: basename(path),
    mediaType,
    byteCount: bytes.byteLength,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    bytes,
  };
}
