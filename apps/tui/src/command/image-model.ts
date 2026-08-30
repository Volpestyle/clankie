import { loadConfig, parseModelRef, updateGlobalConfig } from "@clankie/model-provider";

const IMAGE_MODEL_USAGE =
  "Usage: clankie image-model [status]\n       clankie image-model set provider/model\n       clankie image-model clear";

export interface ImageModelCommandOptions {
  readonly cwd?: string;
  readonly env?: NodeJS.ProcessEnv;
}

export interface ImageModelCommandResult {
  readonly ok: boolean;
  readonly imageModel: string | null;
  readonly issues?: readonly { path: string; message: string }[];
}

export async function imageModelStatus(
  options: ImageModelCommandOptions = {},
): Promise<ImageModelCommandResult> {
  const { config, issues } = await loadConfig(options);
  return {
    ok: issues.length === 0,
    imageModel: config.image_model ?? null,
    ...(issues.length === 0 ? {} : { issues }),
  };
}

export async function imageModelSet(
  ref: string | null,
  options: ImageModelCommandOptions = {},
): Promise<ImageModelCommandResult> {
  if (ref !== null && parseModelRef(ref) === undefined)
    throw new Error(`Invalid model ref ${JSON.stringify(ref)}; expected providerId/modelId.`);
  const config = await updateGlobalConfig(
    (current) => {
      if (ref === null) delete current.image_model;
      else current.image_model = ref;
    },
    options.env === undefined ? {} : { env: options.env },
  );
  return { ok: true, imageModel: config.image_model ?? null };
}

export async function runImageModelCommand(
  args: readonly string[],
  options: ImageModelCommandOptions = {},
): Promise<ImageModelCommandResult> {
  const verb = args[0];
  if (verb === undefined || verb === "status") return await imageModelStatus(options);
  if (verb === "set" && args[1] !== undefined && args.length === 2)
    return await imageModelSet(args[1], options);
  if (verb === "clear" && args.length === 1) return await imageModelSet(null, options);
  throw new Error(IMAGE_MODEL_USAGE);
}
