import { resolvePossessorVoiceCredential } from "@clankie/credential-broker";
import { WebSocket } from "ws";
import {
  POSSESSOR_NARRATION_MAX_CHARS,
  POSSESSOR_VOICE_DEFAULT_URL,
  POSSESSOR_VOICE_SCHEMA_VERSION,
  PossessorServerMessageSchema,
  type PossessorNarrate,
} from "./protocol.ts";

/**
 * The possessor side of the voice seam (ADR 0064).
 *
 * The possessor dials **out** to the bridge, mirroring the activity frame sink:
 * a possessor is the untrusted-by-construction side here, and it should not
 * open a port for the credential-holding process to connect into.
 *
 * Both ports are structurally compatible with `ClankieSpeechPort` and
 * `ClankieHearingPort` in `@clankie/gba-mcp`, so nothing imports across that
 * boundary to satisfy a type.
 */
export interface PossessorVoiceClientOptions {
  /** Loopback bridge endpoint, e.g. ws://127.0.0.1:4323/possessor */
  url: string;
  /** Broker-resolved bearer; never read from the environment. */
  token: string;
  reconnectDelayMs?: number;
  /** Injected for tests; defaults to the real `ws` client. */
  connect?: (url: string, token: string) => PossessorVoiceSocket;
  setTimeoutImpl?: (handler: () => void, ms: number) => unknown;
}

/** Structural view of the socket so tests never open one. */
export interface PossessorVoiceSocket {
  readyState: number;
  send(payload: string): void;
  close(): void;
  on(event: "open" | "close" | "error", listener: () => void): void;
  on(event: "message", listener: (data: unknown) => void): void;
}

export interface PossessorVoiceClient {
  /** Report what just happened in the body. Rejects when the bridge is unreachable. */
  say(text: string): Promise<void>;
  /** Subscribe to room utterances as they happen. Returns an unsubscribe. */
  subscribe(listener: (utterance: string) => void): () => void;
  readonly connected: boolean;
  close(): void;
}

const OPEN = 1;
const DEFAULT_RECONNECT_DELAY_MS = 2_000;

/**
 * Resolve the broker-owned bearer and build a client, or return undefined when
 * the seam has never been bootstrapped. Deny-by-default: a possessor with no
 * credential simply cannot speak, and says so.
 */
export async function createBrokeredPossessorVoiceClient(
  options: Partial<Omit<PossessorVoiceClientOptions, "token">> = {},
): Promise<PossessorVoiceClient | undefined> {
  const token = await resolvePossessorVoiceCredential();
  if (token === undefined) return undefined;
  return createPossessorVoiceClient({ url: POSSESSOR_VOICE_DEFAULT_URL, ...options, token });
}

export function createPossessorVoiceClient(options: PossessorVoiceClientOptions): PossessorVoiceClient {
  const connect = options.connect ?? defaultConnect;
  const schedule = options.setTimeoutImpl ?? ((handler, ms) => setTimeout(handler, ms));
  const reconnectDelayMs = options.reconnectDelayMs ?? DEFAULT_RECONNECT_DELAY_MS;
  const listeners = new Set<(utterance: string) => void>();

  let socket: PossessorVoiceSocket | null = null;
  let closed = false;

  const open = (): void => {
    if (closed) return;
    const next = connect(options.url, options.token);
    socket = next;
    next.on("message", (data: unknown) => {
      const parsed = PossessorServerMessageSchema.safeParse(safeJson(String(data)));
      if (!parsed.success) return;
      for (const listener of listeners) {
        try {
          listener(parsed.data.text);
        } catch {
          // One bad subscriber must not starve the others of the room.
        }
      }
    });
    next.on("close", () => {
      socket = null;
      if (!closed) schedule(open, reconnectDelayMs);
    });
    next.on("error", () => next.close());
  };
  open();

  return {
    say(text) {
      const trimmed = text.trim();
      if (trimmed.length === 0) {
        return Promise.reject(new Error("clankie_speech_empty: nothing to say"));
      }
      if (trimmed.length > POSSESSOR_NARRATION_MAX_CHARS) {
        return Promise.reject(
          new Error(
            `clankie_speech_too_long: ${String(POSSESSOR_NARRATION_MAX_CHARS)} characters is the bound`,
          ),
        );
      }
      if (socket === null || socket.readyState !== OPEN) {
        // Refuse rather than queue: a line about a wall he bumped into is worth
        // nothing thirty seconds later, and a possessor deserves to learn that
        // the body is not reachable instead of believing it spoke.
        return Promise.reject(
          new Error("clankie_speech_unavailable: the Discord bridge is not reachable on the possessor seam"),
        );
      }
      const message: PossessorNarrate = {
        schemaVersion: POSSESSOR_VOICE_SCHEMA_VERSION,
        type: "narrate",
        text: trimmed,
      };
      try {
        socket.send(JSON.stringify(message));
      } catch (error) {
        return Promise.reject(
          new Error(`clankie_speech_send_failed: ${error instanceof Error ? error.message : "unknown"}`),
        );
      }
      return Promise.resolve();
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    get connected() {
      return socket !== null && socket.readyState === OPEN;
    },
    close() {
      closed = true;
      listeners.clear();
      socket?.close();
      socket = null;
    },
  };
}

function defaultConnect(url: string, token: string): PossessorVoiceSocket {
  return new WebSocket(url, {
    headers: { authorization: `Bearer ${token}` },
  }) as unknown as PossessorVoiceSocket;
}

function safeJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}
