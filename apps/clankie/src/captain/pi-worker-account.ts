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
import {
  discoverPiNativeCapability,
  inspectPiInstallation,
  PiNotInstalled,
  PiTooOld,
} from "./pi-native-capability.ts";

/** Inspect the same default profile native Pi opens; no login, refresh or credential mutation. */
export async function localPiWorkerModelStatus(cwd: string): Promise<{ model: string } | { reason: string }> {
  const home = getAgentDir();
  const settings = SettingsManager.create(cwd, home);
  const provider = settings.getDefaultProvider(),
    model = settings.getDefaultModel();
  if (!provider || !model) return { reason: "Choose a default provider and model in the native Pi profile" };
  const stored = readStoredCredential(provider, join(home, "auth.json"));
  if (stored?.type === "oauth" && stored.expires <= Date.now())
    return { reason: "The native Pi profile’s OAuth credential has expired; refresh it in Pi before hiring" };
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
  if (!selected) return { reason: "The native Pi profile’s selected model is unavailable" };
  if (!(await runtime.getAuth(selected, { minOAuthValidityMs: 0 })))
    return { reason: "The native Pi profile’s selected model has no usable authentication" };
  return { model: `${provider}/${model}` };
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

/** Owner-facing action; no process or environment knowledge required. */
export const PI_NOT_ENABLED = "Turn on Pi to use your API key or local model for coding workers.";
const PI_INSTALL_COMMAND = "npm install -g @earendil-works/pi-coding-agent";

/** Native runtime and model authority are independently verified before Pi enters the shared account view. */
export function createPiWorkerStatusReader(options: {
  enabled: () => boolean | Promise<boolean>;
  cwd: string;
  seatModel?: (() => Promise<PiSeatModel | undefined>) | undefined;
}) {
  return async (): Promise<WorkerAccountStatus> => {
    const base = { harness: "pi" as const, label: "default", home: getAgentDir(), headroom: null };
    let state: "not_enabled" | "ready" = "not_enabled";
    try {
      await inspectPiInstallation(process.env);
      if (!(await options.enabled()))
        return { ...base, pi: { state }, signedIn: null, usable: false, reason: PI_NOT_ENABLED };

      const capability = await discoverPiNativeCapability({ harness: "pi", cwd: options.cwd, brief: "" });
      await capability.verify();
      state = "ready";
      let models: readonly string[];
      if (options.seatModel) models = piSeatModelRefs(await options.seatModel());
      else {
        const status = await localPiWorkerModelStatus(options.cwd);
        if ("reason" in status)
          return { ...base, pi: { state }, signedIn: false, usable: false, reason: status.reason };
        models = [status.model];
      }
      if (!models.length)
        return {
          ...base,
          pi: { state },
          signedIn: false,
          usable: false,
          reason: "No authenticated model is available from the configured Pi worker provider",
        };
      return { ...base, pi: { state }, signedIn: true, usable: true, models };
    } catch (error) {
      // Native capability/auth failures can contain paths or secrets; only a safe reason leaves the service.
      // A release refusal names the installed version and the failed surface, so an upgrade stays visible.
      return {
        ...base,
        pi:
          error instanceof PiNotInstalled
            ? { state: "not_installed", installCommand: PI_INSTALL_COMMAND }
            : error instanceof PiTooOld
              ? { state: "too_old", installCommand: PI_INSTALL_COMMAND }
              : { state },
        signedIn: null,
        usable: false,
        reason:
          error instanceof PiNotInstalled || error instanceof PiTooOld
            ? error.message
            : "Pi could not be checked. Check its installation and model sign-in, then try again.",
      };
    }
  };
}
