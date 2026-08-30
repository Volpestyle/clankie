import {
  declareLocalProvider,
  loadConfig,
  LOCAL_CONTEXT_FALLBACK,
  parseModelRef,
  probeLocalModels,
  setCaptainModel,
  type ClankieConfig,
  type ProbedLocalModel,
} from "@clankie/model-provider";

const MODEL_USAGE = [
  "Usage: clankie model [status]",
  "       clankie model add-local --id ID --base-url URL [--context N] [--models id,id] [--set]",
  "       clankie model set providerId/modelId",
].join("\n");

export interface ModelCommandOptions {
  readonly cwd?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly fetchImpl?: typeof fetch;
}

export interface ModelAddLocalInput {
  readonly providerId: string;
  readonly baseURL: string;
  readonly fallbackContext?: number;
  readonly models?: readonly string[];
  readonly setCaptain?: boolean;
}

export type ModelCommandResult =
  | {
      readonly ok: boolean;
      readonly model: string | null;
      readonly effort: string | null;
      readonly providers: Record<string, { baseURL?: string; models: string[] }>;
      readonly issues?: readonly { path: string; message: string }[];
      readonly restart: string;
    }
  | {
      readonly ok: false;
      readonly error: string;
    }
  | {
      readonly ok: true;
      readonly providerId: string;
      readonly baseURL: string;
      readonly models: readonly string[];
      readonly model: string | null;
      readonly restart: string;
      readonly probeError?: string;
    }
  | {
      readonly ok: true;
      readonly model: string;
      readonly restart: string;
    };

function localProviders(config: ClankieConfig): Record<string, { baseURL?: string; models: string[] }> {
  const declared: Record<string, { baseURL?: string; models: string[] }> = {};
  for (const [id, provider] of Object.entries(config.provider ?? {})) {
    const baseURL = typeof provider.options?.baseURL === "string" ? provider.options.baseURL : undefined;
    declared[id] = {
      ...(baseURL === undefined ? {} : { baseURL }),
      models: Object.keys(provider.models ?? {}),
    };
  }
  return declared;
}

export async function modelStatus(
  options: ModelCommandOptions = {},
): Promise<Extract<ModelCommandResult, { readonly providers: Record<string, unknown> }>> {
  const { config, issues } = await loadConfig(options);
  return {
    ok: issues.length === 0,
    model: config.model ?? null,
    effort: config.model === undefined ? null : (config.variant?.[config.model] ?? null),
    providers: localProviders(config),
    ...(issues.length === 0 ? {} : { issues }),
    restart: "clankie restart captain",
  };
}

export async function modelDeclareLocal(
  input: Omit<ModelAddLocalInput, "models"> & { readonly models: readonly ProbedLocalModel[] },
  options: ModelCommandOptions = {},
): Promise<Extract<ModelCommandResult, { readonly providerId: string }>> {
  const config = await declareLocalProvider({
    providerId: input.providerId,
    baseURL: input.baseURL,
    models: input.models,
    fallbackContext: input.fallbackContext ?? LOCAL_CONTEXT_FALLBACK,
    ...(options.env === undefined ? {} : { env: options.env }),
  });
  const providerId = input.providerId.trim().toLowerCase();
  const first = input.models[0]?.id;
  let captain: string | null = config.model ?? null;
  if (input.setCaptain === true && first !== undefined) {
    const next = await setCaptainModel(
      `${providerId}/${first}`,
      options.env === undefined ? {} : { env: options.env },
    );
    captain = next.model ?? `${providerId}/${first}`;
  }
  return {
    ok: true,
    providerId,
    baseURL: config.provider?.[providerId]?.options?.baseURL as string,
    models: input.models.map((model) => model.id),
    model: captain,
    restart: "clankie restart captain",
  };
}

async function modelAddLocal(
  input: ModelAddLocalInput,
  options: ModelCommandOptions = {},
): Promise<ModelCommandResult> {
  let probed: readonly ProbedLocalModel[] = [];
  let probeError: string | undefined;
  try {
    probed = await probeLocalModels(input.baseURL, options.fetchImpl ?? fetch);
  } catch (error) {
    probeError = error instanceof Error ? error.message : String(error);
  }
  const models: readonly ProbedLocalModel[] =
    probed.length > 0 ? probed : (input.models ?? []).map((id) => ({ id }));
  if (models.length === 0) {
    return {
      ok: false,
      error:
        probeError === undefined
          ? "Endpoint listed no models; pass --models id,id."
          : `Could not list models at ${input.baseURL} (${probeError}). Pass --models id,id or start the runtime.`,
    };
  }
  return {
    ...(await modelDeclareLocal({ ...input, models }, options)),
    ...(probeError === undefined ? {} : { probeError }),
  };
}

export async function modelSet(
  ref: string,
  options: ModelCommandOptions = {},
): Promise<Extract<ModelCommandResult, { readonly ok: true; readonly model: string }>> {
  if (parseModelRef(ref) === undefined)
    throw new Error(`Invalid model ref ${JSON.stringify(ref)}; expected providerId/modelId.`);
  const config = await setCaptainModel(ref, options.env === undefined ? {} : { env: options.env });
  return { ok: true, model: config.model ?? ref, restart: "clankie restart captain" };
}

interface AddLocalFlags {
  readonly providerId: string;
  readonly baseURL: string;
  readonly fallbackContext: number;
  readonly models: readonly string[];
  readonly setCaptain: boolean;
}

function parseAddLocalArgs(args: readonly string[]): AddLocalFlags {
  let providerId: string | undefined;
  let baseURL: string | undefined;
  let fallbackContext = LOCAL_CONTEXT_FALLBACK;
  let models: string[] = [];
  let setCaptain = false;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    const next = args[index + 1];
    if (arg === "--id") {
      if (next === undefined) throw new Error(MODEL_USAGE);
      providerId = next;
      index += 1;
      continue;
    }
    if (arg === "--base-url") {
      if (next === undefined) throw new Error(MODEL_USAGE);
      baseURL = next;
      index += 1;
      continue;
    }
    if (arg === "--context") {
      if (next === undefined) throw new Error(MODEL_USAGE);
      const parsed = Number(next);
      if (!Number.isInteger(parsed) || parsed <= 0)
        throw new Error("Context must be a positive whole number of tokens.");
      fallbackContext = parsed;
      index += 1;
      continue;
    }
    if (arg === "--models") {
      if (next === undefined) throw new Error(MODEL_USAGE);
      models = next
        .split(",")
        .map((id) => id.trim())
        .filter((id) => id.length > 0);
      index += 1;
      continue;
    }
    if (arg === "--set") {
      setCaptain = true;
      continue;
    }
    throw new Error(MODEL_USAGE);
  }
  if (providerId === undefined || baseURL === undefined) throw new Error(MODEL_USAGE);
  return { providerId, baseURL, fallbackContext, models, setCaptain };
}

export async function runModelCommand(
  args: readonly string[],
  options: ModelCommandOptions = {},
): Promise<ModelCommandResult> {
  const subcommand = args[0];
  if (subcommand === undefined || subcommand === "status") return await modelStatus(options);
  if (subcommand === "add-local") return await modelAddLocal(parseAddLocalArgs(args.slice(1)), options);
  if (subcommand === "set") {
    const ref = args[1];
    if (ref === undefined || args.length !== 2) throw new Error(MODEL_USAGE);
    return await modelSet(ref, options);
  }
  throw new Error(MODEL_USAGE);
}
