import { loadConfig, parseModelRef, updateGlobalConfig } from "@clankie/model-provider";

const EFFORT_USAGE = [
  "Usage: clankie effort [status]",
  "       clankie effort set LEVEL [--model provider/model]",
  "       clankie effort clear [--model provider/model]",
].join("\n");

export interface EffortCommandOptions {
  readonly cwd?: string;
  readonly env?: NodeJS.ProcessEnv;
}

export interface EffortCommandResult {
  readonly ok: boolean;
  readonly model: string | null;
  readonly effort: string | null;
  readonly issues?: readonly { path: string; message: string }[];
  readonly restart: string;
}

export async function effortStatus(options: EffortCommandOptions = {}): Promise<EffortCommandResult> {
  const { config, issues } = await loadConfig(options);
  const model = config.model ?? null;
  return {
    ok: issues.length === 0,
    model,
    effort: model === null ? null : (config.variant?.[model] ?? null),
    ...(issues.length === 0 ? {} : { issues }),
    restart: "clankie restart captain",
  };
}

async function targetModel(model: string | undefined, options: EffortCommandOptions): Promise<string> {
  const ref = model ?? (await loadConfig(options)).config.model;
  if (ref === undefined || parseModelRef(ref) === undefined)
    throw new Error("No captain model is configured; run `clankie model set provider/model` first.");
  return ref;
}

export async function effortSet(
  effort: string | null,
  model: string | undefined,
  options: EffortCommandOptions = {},
): Promise<EffortCommandResult> {
  if (effort !== null && effort.trim().length === 0) throw new Error("Effort must not be empty.");
  const ref = await targetModel(model, options);
  const config = await updateGlobalConfig(
    (current) => {
      const variants = { ...current.variant };
      if (effort === null) delete variants[ref];
      else variants[ref] = effort;
      current.variant = variants;
    },
    options.env === undefined ? {} : { env: options.env },
  );
  return {
    ok: true,
    model: ref,
    effort: config.variant?.[ref] ?? null,
    restart: "clankie restart captain",
  };
}

function parsedModel(args: readonly string[], offset: number): string | undefined {
  if (args.length === offset) return undefined;
  if (args.length === offset + 2 && args[offset] === "--model") return args[offset + 1];
  throw new Error(EFFORT_USAGE);
}

export async function runEffortCommand(
  args: readonly string[],
  options: EffortCommandOptions = {},
): Promise<EffortCommandResult> {
  const verb = args[0];
  if (verb === undefined || verb === "status") return await effortStatus(options);
  if (verb === "set" && args[1] !== undefined) return await effortSet(args[1], parsedModel(args, 2), options);
  if (verb === "clear") return await effortSet(null, parsedModel(args, 1), options);
  throw new Error(EFFORT_USAGE);
}
