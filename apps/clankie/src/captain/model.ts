import {
  createDefaultCredentialStore,
  type CredentialStore as ClankieCredentialStore,
  type ProviderCredential,
} from "@clankie/credential-broker";
import { loadConfig, parseModelRef } from "@clankie/model-provider";
import type { Credential, CredentialInfo, Model, Api } from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";

export class CaptainModelError extends Error {}

/**
 * Bridges the clankie credential broker (Keychain-backed, written by the TUI
 * /auth flow) into pi-ai's CredentialStore, so pi resolves keys and refreshes
 * OAuth tokens against the same store the rest of the system uses. The shapes
 * are near-identical; only the api-key tag differs.
 */
class BrokerCredentialStore {
  private readonly broker: ClankieCredentialStore;

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

  public async modify(
    providerId: string,
    fn: (current: Credential | undefined) => Promise<Credential | undefined> | Credential | undefined,
  ): Promise<Credential | undefined> {
    const current = toPiCredential(await this.broker.get(providerId));
    const next = await fn(current);
    if (next === undefined) {
      await this.broker.delete(providerId);
      return undefined;
    }
    const mapped = fromPiCredential(next);
    if (mapped !== undefined) await this.broker.set(providerId, mapped);
    return next;
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
    };
  }
  // "wellknown" carries a resolved bearer token; to pi that is just a key.
  return { type: "api_key", key: credential.token };
}

function fromPiCredential(credential: Credential): ProviderCredential | undefined {
  if (credential.type === "api_key") {
    return credential.key === undefined ? undefined : { type: "api", key: credential.key };
  }
  return {
    type: "oauth",
    access: credential.access,
    refresh: credential.refresh,
    expires: credential.expires,
  };
}

export interface CaptainModelRuntime {
  readonly runtime: ModelRuntime;
  /** Resolves the operator-configured captain model, failing with a sayable reason. */
  resolveModel(): Promise<Model<Api>>;
}

export async function createCaptainModelRuntime(repoRoot: string): Promise<CaptainModelRuntime> {
  const broker = createDefaultCredentialStore();
  const runtime = await ModelRuntime.create({
    credentials: new BrokerCredentialStore(broker),
    refreshOnCreate: false,
  });
  return {
    runtime,
    resolveModel: async () => {
      const configured = await loadConfig({ cwd: repoRoot });
      const ref = configured.config.model === undefined ? undefined : parseModelRef(configured.config.model);
      if (ref === undefined) throw new CaptainModelError("No captain model is configured; run /model");
      const model = runtime.getModel(ref.providerId, ref.modelId);
      if (model === undefined) {
        throw new CaptainModelError(
          `Configured captain model ${ref.providerId}/${ref.modelId} is not in pi's catalog`,
        );
      }
      return model;
    },
  };
}
