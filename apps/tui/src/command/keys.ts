import {
  MODEL_KEY_REMOVE_PATH,
  MODEL_KEY_SET_PATH,
  MODEL_KEY_VALIDATE_PATH,
  MODEL_KEYS_PATH,
  ModelKeyResultSchema,
  ModelKeysResponseSchema,
  type ModelKeyResult,
  type ModelKeysResponse,
} from "@clankie/protocol/model-keys";
import { ownerSettingsApi, type OwnerSettingsApiOptions } from "./owner-settings-api.ts";

const USAGE =
  "Usage: clankie keys [status]\n       clankie keys set PROVIDER --key-stdin\n       clankie keys remove PROVIDER\n       clankie keys validate PROVIDER MODEL";
const KEY_BYTES_MAX = 16 * 1024;

export interface KeysCommandOptions extends OwnerSettingsApiOptions {
  /** The secret's only way in: never a flag, a file or the environment. */
  readonly readStdin?: () => Promise<string>;
}

/**
 * The same owner model-key API a hosted body serves, on this Mac's own service.
 * The key goes from stdin to the credential broker through the service; this
 * process never stores or prints it.
 */
export async function runKeysCommand(
  args: readonly string[],
  options: KeysCommandOptions = {},
): Promise<ModelKeysResponse | ModelKeyResult> {
  const [action, providerId, modelId] = args;
  const api = await ownerSettingsApi(options);
  if (action === undefined || action === "status" || action === "list")
    return api.get(MODEL_KEYS_PATH, ModelKeysResponseSchema);
  if (action === "set" && providerId !== undefined && args.length === 3 && args[2] === "--key-stdin") {
    const apiKey = (await (options.readStdin ?? readStdin)()).trim();
    if (!apiKey) throw new Error("No key on stdin");
    return api.write(MODEL_KEY_SET_PATH, { providerId, apiKey }, ModelKeyResultSchema);
  }
  if (action === "remove" && providerId !== undefined && args.length === 2)
    return api.write(MODEL_KEY_REMOVE_PATH, { providerId }, ModelKeyResultSchema);
  if (action === "validate" && providerId !== undefined && modelId !== undefined && args.length === 3)
    return api.write(MODEL_KEY_VALIDATE_PATH, { providerId, modelId }, ModelKeyResultSchema);
  throw new Error(USAGE);
}

async function readStdin(): Promise<string> {
  if (process.stdin.isTTY)
    throw new Error("Pipe the key on stdin, for example: pbpaste | clankie keys set PROVIDER --key-stdin");
  let text = "";
  process.stdin.setEncoding("utf8");
  for await (const chunk of process.stdin) {
    text += String(chunk);
    if (Buffer.byteLength(text) > KEY_BYTES_MAX) throw new Error("Key input too large");
  }
  return text;
}
