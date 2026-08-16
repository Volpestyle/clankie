import {
  createDefaultCredentialStore,
  type CredentialStore as ClankieCredentialStore,
  type ProviderCredential,
} from "@clankie/credential-broker";
import { createModelRegistry } from "@clankie/model-registry";
import {
  loadConfig,
  parseModelRef,
  registerConfiguredPiProviders,
  subscriptionRefFor,
} from "@clankie/model-provider";
import {
  clampThinkingLevel,
  type Credential,
  type CredentialInfo,
  type Model,
  type Api,
  type ModelThinkingLevel,
} from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";

export class CaptainModelError extends Error {}

/**
 * Bridges the clankie credential broker (Keychain-backed, written by the TUI
 * /auth flow) into pi-ai's CredentialStore, so pi resolves keys and refreshes
 * OAuth tokens against the same store the rest of the system uses. The shapes
 * are near-identical; only the api-key tag differs.
 */
export class BrokerCredentialStore {
  private readonly broker: ClankieCredentialStore;
  // pi runs OAuth refresh inside modify() and relies on writes being
  // serialized; two lanes refreshing one provider concurrently would rotate
  // the token twice and strand the second. In-process chain per provider.
  private readonly locks = new Map<string, Promise<unknown>>();

  public constructor(broker: ClankieCredentialStore) {
    this.broker = broker;
  }

  public async read(providerId: string): Promise<Credential | undefined> {
    return toPiCredential(await this.broker.get(providerId));
  }

  public async delete(providerId: string): Promise<void> {
    await this.broker.delete(providerId);
  }

  public async list(): Promise<readonly CredentialInfo[]> {
    const entries = await this.broker.list();
    return Object.entries(entries).map(([providerId, redacted]) => ({
      providerId,
      type: redacted.type === "oauth" ? ("oauth" as const) : ("api_key" as const),
    }));
  }

  public modify(
    providerId: string,
    fn: (current: Credential | undefined) => Promise<Credential | undefined> | Credential | undefined,
  ): Promise<Credential | undefined> {
    const run = (this.locks.get(providerId) ?? Promise.resolve()).then(async () => {
      const stored = await this.broker.get(providerId);
      const next = await fn(toPiCredential(stored));
      if (next === undefined) return toPiCredential(stored);
      const mapped = fromPiCredential(next, stored);
      if (mapped !== undefined) await this.broker.set(providerId, mapped);
      return next;
    });
    this.locks.set(
      providerId,
      run.catch(() => undefined),
    );
    return run;
  }
}

function toPiCredential(credential: ProviderCredential | undefined): Credential | undefined {
  if (credential === undefined) return undefined;
  if (credential.type === "api") return { type: "api_key", key: credential.key };
  if (credential.type === "oauth") {
    return {
      type: "oauth",
      access: credential.access,
      refresh: credential.refresh,
      expires: credential.expires,
      ...(credential.accountId === undefined ? {} : { accountId: credential.accountId }),
    };
  }
  // "wellknown" carries a resolved bearer token; to pi that is just a key.
  return { type: "api_key", key: credential.token };
}

function fromPiCredential(
  credential: Credential,
  stored: ProviderCredential | undefined,
): ProviderCredential | undefined {
  if (credential.type === "api_key") {
    // A wellknown credential surfaces to pi as an api key; never let that
    // round-trip overwrite the stored wellknown pair with a plain api entry.
    if (stored?.type === "wellknown" && credential.key === stored.token) return stored;
    return credential.key === undefined ? undefined : { type: "api", key: credential.key };
  }
  return {
    type: "oauth",
    access: credential.access,
    refresh: credential.refresh,
    expires: credential.expires,
    ...(typeof credential.accountId === "string" ? { accountId: credential.accountId } : {}),
  };
}

export interface CaptainModelSelection {
  readonly model: Model<Api>;
  readonly thinkingLevel: ModelThinkingLevel;
  readonly ref: string;
}

export interface CaptainModelRuntime {
  readonly runtime: ModelRuntime;
  /** Resolves Clankie's configured policy through Pi's model catalog. */
  resolveSelection(): Promise<CaptainModelSelection>;
}

export async function createCaptainModelRuntime(repoRoot: string): Promise<CaptainModelRuntime> {
  const broker = createDefaultCredentialStore();
  const runtime = await ModelRuntime.create({
    credentials: new BrokerCredentialStore(broker),
    modelsPath: null,
    refreshOnCreate: false,
  });
  const initialConfig = await loadConfig({ cwd: repoRoot });
  registerConfiguredPiProviders(runtime, initialConfig.config, await createModelRegistry().catalog());
  return {
    runtime,
    resolveSelection: async () => {
      const configured = await loadConfig({ cwd: repoRoot });
      const ref = configured.config.model === undefined ? undefined : parseModelRef(configured.config.model);
      if (ref === undefined) throw new CaptainModelError("No captain model is configured; run /model");
      if (
        configured.config.disabled_providers?.includes(ref.providerId) === true ||
        (configured.config.enabled_providers !== undefined &&
          configured.config.enabled_providers.length > 0 &&
          !configured.config.enabled_providers.includes(ref.providerId))
      ) {
        throw new CaptainModelError(`Configured captain provider ${ref.providerId} is disabled`);
      }
      const subscriptionRef =
        (await broker.get("openai-codex")) === undefined
          ? undefined
          : subscriptionRefFor(ref, configured.config);
      const effective = parseModelRef(subscriptionRef ?? configured.config.model!);
      if (effective === undefined)
        throw new CaptainModelError(`Invalid captain model ${configured.config.model}`);
      const model = runtime.getModel(effective.providerId, effective.modelId);
      if (model === undefined) {
        throw new CaptainModelError(
          `Configured captain model ${effective.providerId}/${effective.modelId} is not in pi's catalog`,
        );
      }
      const effectiveRef = `${effective.providerId}/${effective.modelId}`;
      const variant =
        configured.config.variant?.[effectiveRef] ?? configured.config.variant?.[configured.config.model!];
      return {
        model,
        ref: effectiveRef,
        thinkingLevel: clampThinkingLevel(model, normalizeThinkingLevel(variant)),
      };
    },
  };
}

function normalizeThinkingLevel(value: string | undefined): ModelThinkingLevel {
  if (value === "none") return "off";
  if (value === "think-8k") return "low";
  if (value === "think-16k") return "medium";
  if (value === "think-24k" || value === "think-32k") return "high";
  if (["off", "minimal", "low", "medium", "high", "xhigh", "max"].includes(value ?? "")) {
    return value as ModelThinkingLevel;
  }
  return "medium";
}
