import { loadConfig, parseModelRef, updateGlobalConfig } from "@clankie/model-provider";

const VIDEO_MODEL_USAGE =
  "Usage: clankie video-model [status]\n       clankie video-model set provider/model\n       clankie video-model clear";

export interface VideoModelCommandOptions {
  readonly cwd?: string;
  readonly env?: NodeJS.ProcessEnv;
}

export interface VideoModelCommandResult {
  readonly ok: boolean;
  readonly videoModel: string | null;
  readonly issues?: readonly { path: string; message: string }[];
}

export async function videoModelStatus(
  options: VideoModelCommandOptions = {},
): Promise<VideoModelCommandResult> {
  const { config, issues } = await loadConfig(options);
  return {
    ok: issues.length === 0,
    videoModel: config.video_model ?? null,
    ...(issues.length === 0 ? {} : { issues }),
  };
}

export async function videoModelSet(
  ref: string | null,
  options: VideoModelCommandOptions = {},
): Promise<VideoModelCommandResult> {
  if (ref !== null && parseModelRef(ref) === undefined)
    throw new Error(`Invalid model ref ${JSON.stringify(ref)}; expected providerId/modelId.`);
  const config = await updateGlobalConfig(
    (current) => {
      if (ref === null) delete current.video_model;
      else current.video_model = ref;
    },
    options.env === undefined ? {} : { env: options.env },
  );
  return { ok: true, videoModel: config.video_model ?? null };
}

export async function runVideoModelCommand(
  args: readonly string[],
  options: VideoModelCommandOptions = {},
): Promise<VideoModelCommandResult> {
  const verb = args[0];
  if (verb === undefined || verb === "status") return await videoModelStatus(options);
  if (verb === "set" && args[1] !== undefined && args.length === 2)
    return await videoModelSet(args[1], options);
  if (verb === "clear" && args.length === 1) return await videoModelSet(null, options);
  throw new Error(VIDEO_MODEL_USAGE);
}
