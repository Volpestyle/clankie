import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { VoiceProviderReadinessSchema, type VoiceProviderReadiness } from "@clankie/protocol";
import {
  openRealtimeTranscriptionSession,
  openXaiStreamingTranscriptionSession,
  openRealtimeWebSocket,
  RealtimeSessionRefusedError,
  type RealtimeSocketFactory,
} from "./realtime-session.ts";

const CACHE_MS = 5 * 60_000;
const PROBE_MS = 5_000;

export interface VoiceProviderReadinessOptions {
  readonly provider: "openai" | "xai" | "anthropic";
  readonly enabled: boolean;
  readonly model?: string;
  /** Brokered API credentials only. OAuth and environment keys do not qualify. */
  readonly getApiKey: (provider: string) => Promise<string | undefined>;
  readonly env?: NodeJS.ProcessEnv;
  /** Transport seams for the local provider integration proof; never owner settings. */
  readonly socketFactory?: RealtimeSocketFactory;
  readonly baseUrl?: string;
}

/**
 * Five-minute disk cache shared by CLI processes and the service. Reserve the
 * cache before touching the network, so errors, concurrent reads and a crashed
 * probe cannot turn repeated doctor reads into repeated provider requests.
 * Cache failure refuses to probe. Only codes and a one-way credential identity
 * are persisted; provider messages, headers and credentials never leave the port.
 */
export async function readVoiceProviderReadiness(
  options: VoiceProviderReadinessOptions,
): Promise<VoiceProviderReadiness> {
  const checkedProvider = options.provider === "xai" ? "xai" : "openai";
  let now = Date.now();
  const result = (state: VoiceProviderReadiness["state"]): VoiceProviderReadiness => ({
    provider: options.provider,
    checkedProvider,
    scope: "transcription",
    state,
    checkedAt: new Date(now).toISOString(),
    expiresAt: new Date(now + CACHE_MS).toISOString(),
    cached: false,
  });
  if (!options.enabled) return result("disabled");
  let key: string | undefined;
  try {
    key = await options.getApiKey(checkedProvider);
  } catch {
    return result("unavailable");
  }
  if (!key?.trim()) return result("missing_key");
  now = Date.now();
  const env = options.env ?? process.env;
  const directory = join(
    env.CLANKIE_STATE?.trim() || join(env.HOME?.trim() || homedir(), ".clankie"),
    "voice-provider-readiness",
  );
  const model = checkedProvider === "openai" ? (options.model ?? "gpt-realtime-whisper") : undefined;
  const identity = createHash("sha256")
    .update(JSON.stringify([options.provider, model, options.baseUrl, key]))
    .digest("hex");
  const path = join(directory, `${identity}.json`);
  const lock = `${path}.lock`;
  const cached = async () => {
    try {
      const value = VoiceProviderReadinessSchema.parse(JSON.parse(await readFile(path, "utf8")));
      if (Date.parse(value.expiresAt) > Date.now() && Date.parse(value.checkedAt) <= Date.now())
        return { ...value, cached: true };
    } catch {
      /* Missing, expired or corrupt caches are replaced only under the lock. */
    }
    return undefined;
  };
  const previous = await cached();
  if (previous) return previous;
  try {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    // A lock only covers local disk I/O, never the provider request. Recover a
    // process that died before writing its reservation after thirty seconds.
    try {
      if (Date.now() - (await stat(lock)).mtimeMs > 30_000) await rm(lock, { recursive: true, force: true });
    } catch {
      /* No lock yet. */
    }
    await mkdir(lock, { mode: 0o700 });
  } catch (error) {
    return (
      (await cached()) ??
      result((error as NodeJS.ErrnoException).code === "EEXIST" ? "checking" : "unavailable")
    );
  }
  const persist = async (value: VoiceProviderReadiness) => {
    const temporary = `${path}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, JSON.stringify(value), { mode: 0o600, flag: "wx" });
      await rename(temporary, path);
    } finally {
      await rm(temporary, { force: true });
    }
  };
  try {
    const existing = await cached();
    if (existing) return existing;
    await persist(result("checking"));
  } catch {
    return result("unavailable");
  } finally {
    try {
      await rm(lock, { recursive: true, force: true });
    } catch {
      /* The durable reservation still rate-limits requests if cleanup fails. */
    }
  }

  let session:
    | Awaited<ReturnType<typeof openRealtimeTranscriptionSession>>
    | Awaited<ReturnType<typeof openXaiStreamingTranscriptionSession>>
    | undefined;
  const abort = new AbortController();
  let deadline: ReturnType<typeof setTimeout> | undefined;
  let expired = false;
  let observation = result("unconfirmed");
  try {
    const timeout = new Promise<never>((_, reject) => {
      deadline = setTimeout(() => {
        expired = true;
        abort.abort();
        reject(new Error("deadline"));
      }, PROBE_MS);
    });
    const attempt = (async () => {
      const open =
        checkedProvider === "xai" ? openXaiStreamingTranscriptionSession : openRealtimeTranscriptionSession;
      session = await open({
        apiKey: key,
        ...(model === undefined ? {} : { model }),
        ...(options.baseUrl === undefined ? {} : { baseUrl: options.baseUrl }),
        socketFactory: (url, headers) =>
          (options.socketFactory ?? openRealtimeWebSocket)(url, headers, abort.signal),
        onTranscript: () => undefined,
      });
      if (expired) {
        session.close();
        return;
      }
      await session.accepted;
    })();
    await Promise.race([attempt, timeout]);
    observation = result("ready");
  } catch (error) {
    observation =
      !expired && error instanceof RealtimeSessionRefusedError
        ? {
            ...result("refused"),
            ...(error.detail.providerCode === undefined ? {} : { providerCode: error.detail.providerCode }),
          }
        : result(expired ? "unconfirmed" : "unavailable");
  } finally {
    clearTimeout(deadline);
    session?.close();
    abort.abort();
  }
  // Retain the reservation on a failed final write: still no provider retry.
  try {
    await persist(observation);
  } catch {
    /* The reservation remains cached. */
  }
  return observation;
}
