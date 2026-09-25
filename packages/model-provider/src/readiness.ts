import { loadBundledCatalog } from "@clankie/model-registry";
import { parseModelRef, type ClankieConfig } from "./config.ts";
import { CODEX_PROVIDER_ID } from "./oauth/openai-codex.ts";
import { subscriptionRefFor } from "./resolve.ts";

/**
 * Whether Clankie can think at all: a captain model is chosen and something
 * can authenticate it. This is the whole of required setup; every other
 * setting has a default or belongs to an optional room. The console opens
 * `/setup` on it and `doctor` reports it, so both answer "why would a first
 * message fail" the way the captain resolves auth for a turn.
 */
export type CaptainReadiness =
  | {
      readonly ready: true;
      readonly model: string;
      readonly providerId: string;
      /** What authenticates the model: a stored credential, a provider env var, a declared endpoint, or the ChatGPT subscription serving an `openai/` ref. */
      readonly auth: "credential" | "env" | "endpoint" | "subscription";
    }
  | {
      readonly ready: false;
      readonly reason: "no_model" | "no_credential";
      readonly model?: string;
      readonly providerId?: string;
    };

export function captainReadiness(input: {
  readonly config: ClankieConfig;
  readonly credentialIds: ReadonlySet<string> | readonly string[];
  readonly env?: NodeJS.ProcessEnv;
}): CaptainReadiness {
  const model = input.config.model;
  const parsed = model === undefined ? undefined : parseModelRef(model);
  if (model === undefined || parsed === undefined) return { ready: false, reason: "no_model" };
  const { providerId } = parsed;
  const credentialIds = new Set(input.credentialIds);
  if (credentialIds.has(providerId)) return { ready: true, model, providerId, auth: "credential" };
  if (providerEnvConnected(providerId, input.env ?? process.env)) {
    return { ready: true, model, providerId, auth: "env" };
  }
  // A declared endpoint may be keyless; `doctor` probes whether it wants a key.
  if (input.config.provider?.[providerId] !== undefined) {
    return { ready: true, model, providerId, auth: "endpoint" };
  }
  if (credentialIds.has(CODEX_PROVIDER_ID) && subscriptionRefFor(parsed, input.config) !== undefined) {
    return { ready: true, model, providerId, auth: "subscription" };
  }
  return { ready: false, reason: "no_credential", model, providerId };
}

/** A provider key exported in the environment under any name models.dev lists for it. */
export function providerEnvConnected(providerId: string, env: NodeJS.ProcessEnv): boolean {
  return (loadBundledCatalog()[providerId]?.env ?? []).some((variable) => (env[variable] ?? "") !== "");
}
