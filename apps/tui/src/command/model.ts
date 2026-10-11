import { createModelRegistry, type Catalog } from "@clankie/model-registry";
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
import { runModelCompactionCommand, type ModelCompactionStatus } from "./model-compaction.ts";
import { runModelRoutingCommand, type ModelRoutingStatus } from "./model-routing.ts";

import { runModelSubscriptionsCommand, type ModelSubscriptionsCommandResult } from "./model-subscriptions.ts";
import type { CredentialStore } from "@clankie/credential-broker";
import { resolveOperatorCredential } from "@clankie/credential-broker";
import {
  MODEL_SETTINGS_PATH,
  ModelSettingsResponseSchema,
  ModelKeyResultSchema,
  type ModelSettingsResponse,
} from "@clankie/protocol/model-keys";
import { commandHost } from "./io.ts";

const MODEL_USAGE = [
  "Usage: clankie model [status]",
  "       clankie model refresh",
  "       clankie model subscriptions [list|methods|start|status|cancel] …",
  "       clankie model add-local --id ID --base-url URL [--context N] [--models id,id] [--set]",
  "       clankie model set providerId/modelId",
  "       clankie model routing [status|set|off|escalate|purpose|turn-limit] …",
  "       clankie model compaction [status|set TOKENS|default]",
].join("\n");

export interface ModelCommandOptions {
  readonly cwd?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly fetchImpl?: typeof fetch | undefined;
  readonly host?: string;
  readonly operatorCredentialStore?: CredentialStore;
}

export interface ModelAddLocalInput {
  readonly providerId: string;
  readonly baseURL: string;
  readonly fallbackContext?: number;
  readonly models?: readonly string[];
  readonly setCaptain?: boolean;
}

export type ModelCommandResult =
  | ModelSubscriptionsCommandResult
  | ModelRoutingStatus
  | ModelCompactionStatus
  | {
      readonly ok: boolean;
      readonly model: string | null;
      readonly effort: string | null;
      readonly providers: Record<string, { baseURL?: string; models: string[] }>;
      readonly issues?: readonly { path: string; message: string }[];
      readonly restart: string;
      readonly settings?: ModelSettingsResponse;
      readonly display?: readonly string[];
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
    }
  | {
      readonly ok: boolean;
      readonly source: "network" | "cache" | "bundled";
      readonly updated: boolean;
      readonly providers: number;
      readonly models: number;
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
    restart: "clankie restart",
  };
}

/** Plain settings text from the same authenticated read used by every client. */
export function modelSettingsSummary(settings: ModelSettingsResponse): string[] {
  const name = (entry: ModelSettingsResponse["effective"]) =>
    entry?.actual ? `${entry.actual.modelName} · ${entry.actual.providerName}` : "Model unavailable";
  return [
    `${name(settings.effective)} · ${settings.effective?.funding === "included" ? "Included AI credits" : settings.effective ? "Your own provider" : "Funding unavailable"}`,
    "Credit rates are unavailable. Input, output and cached usage rates cannot be compared yet.",
    ...(settings.openItems.includes("included_catalog_policy")
      ? ["Included model choices are unavailable."]
      : []),
    "Clankie routes each turn automatically. Your choice applies to new turns.",
    ...settings.routing.map(
      (route) =>
        `${{ operator: "Your conversations", discord_social: "Discord chat", discord_granted: "Discord tasks", gameplay: "Gameplay" }[route.purpose]}: ${name(route.initial)}${route.escalation ? `; stronger model: ${name(route.escalation)}` : ""}`,
    ),
  ];
}

/** All ordinary model reads/writes use the service's owner authorization. */
export async function readModelSettings(options: ModelCommandOptions = {}): Promise<ModelSettingsResponse> {
  const value = await modelSettingsRequest(options);
  return ModelSettingsResponseSchema.parse(value);
}

async function modelSettingsRequest(options: ModelCommandOptions, model?: string): Promise<unknown> {
  const env = options.env ?? process.env;
  const credential = await resolveOperatorCredential({
    env,
    ...(options.operatorCredentialStore ? { store: options.operatorCredentialStore } : {}),
  });
  if (!credential) throw new Error("authentication_required");
  const response = await (options.fetchImpl ?? fetch)(
    new URL(MODEL_SETTINGS_PATH, commandHost({ ...options, env })),
    {
      method: model === undefined ? "GET" : "POST",
      headers: {
        authorization: `Bearer ${credential.token}`,
        ...(model === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(model === undefined ? {} : { body: JSON.stringify({ model }) }),
      signal: AbortSignal.timeout(10_000),
      redirect: "error",
    },
  );
  const value: unknown = await response.json();
  if (!response.ok)
    throw new Error(
      ModelKeyResultSchema.safeParse(value).success &&
        typeof value === "object" &&
        value !== null &&
        "error" in value
        ? String(value.error)
        : "unavailable",
    );
  return value;
}

export async function modelDeclareLocal(
  input: Omit<ModelAddLocalInput, "models"> & { readonly models: readonly ProbedLocalModel[] },
  options: ModelCommandOptions = {},
): Promise<Extract<ModelCommandResult, { readonly providerId: string; readonly baseURL: string }>> {
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
    restart: "clankie restart",
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

/**
 * Re-reads the models.dev catalog every selection surface resolves against.
 *
 * The catalog is otherwise frozen at whatever the disk cache holds — the
 * bundled snapshot on a fresh install — because `catalog()` deliberately never
 * touches the network. So a model released after the installed version, Astra
 * included, is invisible to `model set`, to the captain, and to gameplay until
 * something fetches. The TUI does it inside `/provider` and `/model`; a
 * headless install needs a command of its own, and the running service picks
 * the new catalog up on `clankie restart`.
 */
async function modelRefresh(
  options: ModelCommandOptions = {},
): Promise<Extract<ModelCommandResult, { readonly source: string }>> {
  const registry = createModelRegistry({
    ...(options.env === undefined ? {} : { env: options.env }),
    ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
  });
  const result = await registry.refresh(true);
  const catalog = await registry.catalog();
  return {
    // A network failure falls back to cache or bundled rather than throwing, so
    // the source is the honest answer about what a later resolve will read.
    ok: result.source === "network" || result.updated,
    source: result.source,
    updated: result.updated,
    providers: Object.keys(catalog).length,
    models: countModels(catalog),
    restart: "clankie restart",
  };
}

function countModels(catalog: Catalog): number {
  return Object.values(catalog).reduce((total, provider) => total + Object.keys(provider.models).length, 0);
}

/** First-run setup precedes the service; ordinary selections use modelSet. */
export async function modelSetForSetup(ref: string, options: ModelCommandOptions = {}): Promise<void> {
  await setCaptainModel(ref, options.env === undefined ? {} : { env: options.env });
}

export async function modelSet(
  ref: string,
  options: ModelCommandOptions = {},
): Promise<Extract<ModelCommandResult, { readonly ok: true; readonly model: string }>> {
  if (parseModelRef(ref) === undefined)
    throw new Error(`Invalid model ref ${JSON.stringify(ref)}; expected providerId/modelId.`);
  const result = ModelKeyResultSchema.parse(await modelSettingsRequest(options, ref));
  if (!result.ok) throw new Error(result.error);
  return { ok: true, model: ref, restart: "applies to new turns" };
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
  if (subcommand === undefined || subcommand === "status") {
    const settings = await readModelSettings(options);
    return {
      ...(await modelStatus(options)),
      model: settings.selected,
      settings,
      display: modelSettingsSummary(settings),
      restart: "applies to new turns",
    };
  }
  if (subcommand === "refresh") {
    if (args.length !== 1) throw new Error(MODEL_USAGE);
    return await modelRefresh(options);
  }
  if (subcommand === "subscriptions") {
    const { fetchImpl, ...rest } = options;
    return runModelSubscriptionsCommand(args.slice(1), {
      ...rest,
      ...(fetchImpl === undefined ? {} : { fetchImpl }),
    });
  }
  if (subcommand === "routing") return await runModelRoutingCommand(args.slice(1), options);
  if (subcommand === "compaction") return await runModelCompactionCommand(args.slice(1), options);
  if (subcommand === "add-local") return await modelAddLocal(parseAddLocalArgs(args.slice(1)), options);
  if (subcommand === "set") {
    const ref = args[1];
    if (ref === undefined || args.length !== 2) throw new Error(MODEL_USAGE);
    return await modelSet(ref, options);
  }
  throw new Error(MODEL_USAGE);
}
