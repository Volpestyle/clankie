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

type Writable = { write(chunk: string): unknown };

export const MODEL_USAGE = [
  "Usage: clankie model [status]",
  "       clankie model add-local --id ID --base-url URL [--context N] [--models id,id] [--set]",
  "       clankie model set providerId/modelId",
].join("\n");

export interface ModelCliOptions {
  readonly env?: NodeJS.ProcessEnv;
  readonly fetchImpl?: typeof fetch;
  readonly stderr?: Writable;
  readonly stdout?: Writable;
}

function outputJson(stream: Writable, value: unknown): void {
  stream.write(`${JSON.stringify(value)}\n`);
}

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

async function runStatus(options: ModelCliOptions): Promise<number> {
  const env = options.env ?? process.env;
  const { config, issues } = await loadConfig({ env });
  const ok = issues.length === 0;
  outputJson(options.stdout ?? process.stdout, {
    ok,
    model: config.model ?? null,
    providers: localProviders(config),
    ...(issues.length === 0 ? {} : { issues }),
    restart: "clankie restart captain",
  });
  return ok ? 0 : 1;
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

async function runAddLocal(args: readonly string[], options: ModelCliOptions): Promise<number> {
  const flags = parseAddLocalArgs(args);
  const env = options.env ?? process.env;
  const stdout = options.stdout ?? process.stdout;
  let probed: readonly ProbedLocalModel[] = [];
  let probeError: string | undefined;
  try {
    probed = await probeLocalModels(flags.baseURL, options.fetchImpl ?? fetch);
  } catch (error) {
    probeError = error instanceof Error ? error.message : String(error);
  }
  const models: readonly ProbedLocalModel[] = probed.length > 0 ? probed : flags.models.map((id) => ({ id }));
  if (models.length === 0) {
    outputJson(stdout, {
      ok: false,
      error:
        probeError === undefined
          ? "Endpoint listed no models; pass --models id,id."
          : `Could not list models at ${flags.baseURL} (${probeError}). Pass --models id,id or start the runtime.`,
    });
    return 1;
  }
  const config = await declareLocalProvider({
    providerId: flags.providerId,
    baseURL: flags.baseURL,
    models,
    fallbackContext: flags.fallbackContext,
    env,
  });
  const providerId = flags.providerId.trim().toLowerCase();
  const first = models[0]?.id;
  let captain: string | null = config.model ?? null;
  if (flags.setCaptain && first !== undefined) {
    const next = await setCaptainModel(`${providerId}/${first}`, { env });
    captain = next.model ?? `${providerId}/${first}`;
  }
  outputJson(stdout, {
    ok: true,
    providerId,
    baseURL: config.provider?.[providerId]?.options?.baseURL ?? flags.baseURL,
    models: models.map((model) => model.id),
    model: captain,
    restart: "clankie restart captain",
    ...(probeError === undefined ? {} : { probeError }),
  });
  return 0;
}

async function runSet(args: readonly string[], options: ModelCliOptions): Promise<number> {
  const ref = args[0];
  if (ref === undefined || args.length !== 1) throw new Error(MODEL_USAGE);
  if (parseModelRef(ref) === undefined)
    throw new Error(`Invalid model ref ${JSON.stringify(ref)}; expected providerId/modelId.`);
  const config = await setCaptainModel(ref, { env: options.env ?? process.env });
  outputJson(options.stdout ?? process.stdout, {
    ok: true,
    model: config.model ?? ref,
    restart: "clankie restart captain",
  });
  return 0;
}

export async function runModelCommand(args: readonly string[], options: ModelCliOptions): Promise<number> {
  const subcommand = args[0];
  if (subcommand === undefined || subcommand === "status") return await runStatus(options);
  if (subcommand === "add-local") return await runAddLocal(args.slice(1), options);
  if (subcommand === "set") return await runSet(args.slice(1), options);
  if (subcommand === "help" || subcommand === "--help" || subcommand === "-h") {
    (options.stdout ?? process.stdout).write(`${MODEL_USAGE}\n`);
    return 0;
  }
  throw new Error(MODEL_USAGE);
}
