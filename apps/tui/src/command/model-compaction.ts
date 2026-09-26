import {
  INCLUDED_USAGE_COMPACT_AT_TOKENS,
  loadConfig,
  PI_COMPACTION_RESERVE_TOKENS,
  updateGlobalConfig,
} from "@clankie/model-provider";

export const MODEL_COMPACTION_USAGE = [
  "Usage: clankie model compaction [status]",
  "       clankie model compaction set TOKENS",
  "       clankie model compaction default",
].join("\n");

export interface ModelCompactionOptions {
  readonly cwd?: string;
  readonly env?: NodeJS.ProcessEnv;
}

export interface ModelCompactionStatus {
  readonly ok: boolean;
  /** The owner's setting, or null when unset. */
  readonly compactAtTokens: number | null;
  /** Where included usage (the hosted `clankie/*` models) compacts when unset. */
  readonly includedUsageDefault: number;
  /** "every model" when set; otherwise only included usage is bounded. */
  readonly appliesTo: "every model" | "included usage";
  readonly issues?: readonly { path: string; message: string }[];
}

async function modelCompactionStatus(
  options: ModelCompactionOptions = {},
): Promise<ModelCompactionStatus> {
  const { config, issues } = await loadConfig(options);
  return {
    ok: issues.length === 0,
    compactAtTokens: config.compact_at_tokens ?? null,
    includedUsageDefault: INCLUDED_USAGE_COMPACT_AT_TOKENS,
    appliesTo: config.compact_at_tokens === undefined ? "included usage" : "every model",
    ...(issues.length === 0 ? {} : { issues }),
  };
}

/** A token count, or null to return to the default. Takes effect on each session's next model change or new session. */
async function modelCompactionSet(
  tokens: number | null,
  options: ModelCompactionOptions = {},
): Promise<ModelCompactionStatus> {
  if (tokens !== null && (!Number.isInteger(tokens) || tokens < PI_COMPACTION_RESERVE_TOKENS)) {
    throw new Error(
      `Compaction threshold must be a whole number of tokens, at least ${String(PI_COMPACTION_RESERVE_TOKENS)}.`,
    );
  }
  await updateGlobalConfig(
    (current) => {
      if (tokens === null) delete current.compact_at_tokens;
      else current.compact_at_tokens = tokens;
    },
    options.env === undefined ? {} : { env: options.env },
  );
  return await modelCompactionStatus(options);
}

export async function runModelCompactionCommand(
  args: readonly string[],
  options: ModelCompactionOptions = {},
): Promise<ModelCompactionStatus> {
  const [verb, value] = args;
  if (verb === undefined || (verb === "status" && args.length === 1))
    return await modelCompactionStatus(options);
  if (verb === "default" && args.length === 1) return await modelCompactionSet(null, options);
  if (verb === "set" && value !== undefined && args.length === 2) {
    return await modelCompactionSet(Number(value.replaceAll("_", "")), options);
  }
  throw new Error(MODEL_COMPACTION_USAGE);
}
