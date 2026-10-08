import { join } from "node:path";
import {
  getAgentDir,
  ModelRuntime,
  readStoredCredential,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import type { CredentialStore } from "@earendil-works/pi-ai";
import type { WorkerAccountStatus } from "./harness-accounts.ts";
import type { PiSeatModel } from "./herdr-watch.ts";
import { discoverPiNativeCapability } from "./pi-native-capability.ts";

/** Inspect the same default profile native Pi opens; no login, refresh or credential mutation. */
export async function localPiWorkerModel(cwd: string): Promise<string | undefined> {
  const home = getAgentDir();
  const settings = SettingsManager.create(cwd, home);
  const provider = settings.getDefaultProvider(),
    model = settings.getDefaultModel();
  if (!provider || !model) return undefined;
  const stored = readStoredCredential(provider, join(home, "auth.json"));
  if (stored?.type === "oauth" && stored.expires <= Date.now()) return undefined;
  const credentials: CredentialStore = {
    read: async (id) => (id === provider ? stored : undefined),
    list: async () => (stored === undefined ? [] : [{ providerId: provider, type: stored.type }]),
    modify: async () => {
      throw new Error("Worker account inspection cannot refresh credentials");
    },
    delete: async () => {
      throw new Error("Worker account inspection cannot delete credentials");
    },
  };
  const runtime = await ModelRuntime.create({
    credentials,
    modelsPath: join(home, "models.json"),
    refreshOnCreate: false,
  });
  const selected = runtime.getModel(provider, model);
  return selected && (await runtime.getAuth(selected, { minOAuthValidityMs: 0 }))
    ? `${provider}/${model}`
    : undefined;
}

/** Model references declared by this authenticated provider, without any provider config or secret. */
export function piSeatModelRefs(selected: PiSeatModel | undefined): readonly string[] {
  const provider = selected?.provider;
  if (
    !selected ||
    !provider ||
    !/^[a-z0-9][a-z0-9_.-]{0,99}$/u.test(provider.id) ||
    typeof provider.config.baseUrl !== "string" ||
    !provider.config.baseUrl ||
    typeof provider.config.apiKey !== "string" ||
    !provider.config.apiKey
  )
    return [];
  const prefix = `${provider.id}/`;
  // Declared IDs are raw native model IDs: slashes/colons belong to the model,
  // while the authenticated provider alone owns the outer authority prefix.
  const modelId = (value: unknown): string | undefined =>
    typeof value === "string" && value.length > 0 && value.length <= 512 && !/[\s\p{Cc}]/u.test(value)
      ? `${prefix}${value}`
      : undefined;
  if (!selected.model.startsWith(prefix) || !modelId(selected.model.slice(prefix.length))) return [];
  const declared = Array.isArray(provider.config.models)
    ? provider.config.models
        .slice(0, 2047)
        .flatMap((entry) =>
          typeof entry === "object" && entry !== null && "id" in entry
            ? [modelId(entry.id)].filter((ref): ref is string => ref !== undefined)
            : [],
        )
    : [];
  return [...new Set([selected.model, ...declared])];
}

/** Native runtime and model authority are independently verified before Pi enters the shared account view. */
export function createPiWorkerStatusReader(options: {
  enabled: () => boolean;
  cwd: string;
  seatModel?: (() => Promise<PiSeatModel | undefined>) | undefined;
}) {
  return async (): Promise<WorkerAccountStatus> => {
    const base = { harness: "pi" as const, label: "default", home: getAgentDir(), headroom: null };
    if (!options.enabled())
      return { ...base, signedIn: null, usable: false, reason: "Native Pi control is not enabled" };
    try {
      const capability = await discoverPiNativeCapability({ harness: "pi", cwd: options.cwd, brief: "" });
      await capability.verify();
      const models = options.seatModel
        ? piSeatModelRefs(await options.seatModel())
        : [await localPiWorkerModel(options.cwd)].filter((ref): ref is string => ref !== undefined);
      if (!models.length)
        return {
          ...base,
          signedIn: false,
          usable: false,
          reason: "No authenticated model is available in the native Pi profile",
        };
      return { ...base, signedIn: true, usable: true, models };
    } catch {
      // Native capability/auth failures can contain paths or secrets; only a safe reason leaves the service.
      return {
        ...base,
        signedIn: null,
        usable: false,
        reason: "Native Pi capability or model authentication could not be verified",
      };
    }
  };
}
