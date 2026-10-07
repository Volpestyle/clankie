import { resolveOperatorCredential, type CredentialStore } from "@clankie/credential-broker";
import { z } from "zod";
import { parseProtocolResponse } from "@clankie/protocol";
import { HostSettingsSnapshotSchema } from "@clankie/protocol/owner-settings";
import { createCaptainRouteClient, type CaptainRouteFetcher } from "../session/operator-conversations.ts";
import { commandHost } from "./io.ts";

export interface OwnerSettingsApiOptions {
  readonly env?: NodeJS.ProcessEnv;
  readonly host?: string;
  readonly fetchImpl?: typeof fetch;
  readonly operatorCredentialStore?: CredentialStore;
  /** An already owner-authenticated local or hosted transport. */
  readonly ownerFetcher?: CaptainRouteFetcher | undefined;
}
export interface OwnerSettingsApi {
  get<T>(path: string, schema: z.ZodType<T>): Promise<T>;
  write<T>(path: string, body: unknown, schema: z.ZodType<T>, method?: "POST" | "PUT"): Promise<T>;
}
class OwnerSettingsApiError extends Error {
  public readonly status: number;
  public constructor(status: number, detail: string) {
    super(
      status === 409 ? "Settings changed. Read the current settings and review your change again." : detail,
    );
    this.status = status;
  }
}
/** One owner route for CLI/TUI settings; no file fallback or automatic retry. */
export async function ownerSettingsApi(options: OwnerSettingsApiOptions = {}): Promise<OwnerSettingsApi> {
  let transport = options.ownerFetcher;
  if (!transport) {
    const env = options.env ?? process.env;
    const credential = await resolveOperatorCredential({
      env,
      ...(options.operatorCredentialStore === undefined ? {} : { store: options.operatorCredentialStore }),
    });
    if (!credential) throw new Error("Owner operator credential required for settings");
    transport = createCaptainRouteClient({
      host: commandHost(options),
      captainToken: credential.token,
      ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
    });
  }
  const fetcher = transport;
  const request = async <T>(path: string, schema: z.ZodType<T>, init?: RequestInit): Promise<T> => {
    const response = await fetcher.fetch(path, init);
    const value = await response.json().catch(() => null);
    if (!response.ok)
      throw new OwnerSettingsApiError(
        response.status,
        value?.error === "keep_awake_apply_failed" &&
          value.saved === true &&
          HostSettingsSnapshotSchema.safeParse(value.settings).success
          ? "Keep-awake was saved, but the launcher could not apply it. Read clankie awake status to reconcile before choosing a repair."
          : (value?.error ?? `Owner settings request failed (${response.status})`),
      );
    return parseProtocolResponse(schema, value);
  };
  return {
    get: (path, schema) => request(path, schema),
    write: (path, body, schema, method = "POST") =>
      request(path, schema, {
        method,
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
  };
}
