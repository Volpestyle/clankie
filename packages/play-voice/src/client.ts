import { resolvePlayVoiceCredential } from "@clankie/credential-broker";
import { WebSocket } from "ws";
import {
  PLAY_NARRATION_MAX_CHARS,
  PLAY_VOICE_DEFAULT_URL,
  PLAY_VOICE_SCHEMA_VERSION,
  PlayServerMessageSchema,
  type PlayNarrate,
} from "./protocol.ts";

/**
 * Clankie's play side of the voice seam (ADR 0064).
 *
 * Play dials **out** to the active Discord body, mirroring the activity frame sink:
 * play is the untrusted-by-construction side here, and it should not
 * open a port for the credential-holding process to connect into.
 *
 * This package is internal to Clankie's play path and both Discord bodies.
 * External harnesses do not receive this capability.
 */
export interface PlayVoiceClientOptions {
  /** Loopback Discord body endpoint, e.g. ws://127.0.0.1:4323/play */
  url: string;
  /** Broker-resolved bearer; never read from the environment. */
  token: string;
  reconnectDelayMs?: number;
  /** Injected for tests; defaults to the real `ws` client. */
  connect?: (url: string, token: string) => PlayVoiceSocket;
  setTimeoutImpl?: (handler: () => void, ms: number) => unknown;
}

/** Structural view of the socket so tests never open one. */
export interface PlayVoiceSocket {
  readyState: number;
  send(payload: string): void;
  close(): void;
  on(event: "open" | "close" | "error", listener: () => void): void;
  on(event: "message", listener: (data: unknown) => void): void;
}

export interface PlayVoiceClient {
  /**
   * Report the body's current experience — an event, never a sentence to say.
   * The persona on the other side composes the words (ADR 0064), so a caller
   * that passes finished speech here gets it treated as something that
   * happened and replied to, which is the ADR 0074 defect. Rejects when the
   * bridge is unreachable.
   */
  narrate(
    text: string,
    options?: { readonly deliveryId?: string; readonly respond?: boolean },
  ): Promise<void>;
  /** Subscribe to room utterances as they happen. Returns an unsubscribe. */
  subscribe(listener: (utterance: string) => void): () => void;
  /**
   * Whether anyone can currently hear this body. False until the bridge says
   * otherwise, so play that never hears from the Discord body behaves as if
   * the room is empty and keeps authoring for its own surfaces (ADR 0074).
   */
  readonly roomListening: boolean;
  readonly connected: boolean;
  close(): void;
}

const OPEN = 1;
const DEFAULT_RECONNECT_DELAY_MS = 2_000;

/**
 * Resolve the broker-owned bearer and build a client, or return undefined when
 * the seam has never been bootstrapped. Deny-by-default: play with no
 * credential simply cannot speak, and says so.
 */
export async function createBrokeredPlayVoiceClient(
  options: Partial<Omit<PlayVoiceClientOptions, "token">> = {},
): Promise<PlayVoiceClient | undefined> {
  const token = await resolvePlayVoiceCredential();
  if (token === undefined) return undefined;
  return createPlayVoiceClient({ url: PLAY_VOICE_DEFAULT_URL, ...options, token });
}

export function createPlayVoiceClient(options: PlayVoiceClientOptions): PlayVoiceClient {
  const connect = options.connect ?? defaultConnect;
  const schedule = options.setTimeoutImpl ?? ((handler, ms) => setTimeout(handler, ms));
  const reconnectDelayMs = options.reconnectDelayMs ?? DEFAULT_RECONNECT_DELAY_MS;
  const listeners = new Set<(utterance: string) => void>();

  let socket: PlayVoiceSocket | null = null;
  let closed = false;
  let roomListening = false;

  const open = (): void => {
    if (closed) return;
    const next = connect(options.url, options.token);
    socket = next;
    next.on("message", (data: unknown) => {
      const parsed = PlayServerMessageSchema.safeParse(safeJson(String(data)));
      if (!parsed.success) return;
      if (parsed.data.type === "room") {
        roomListening = parsed.data.listening;
        return;
      }
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
      // A dropped seam is not a silent room: reverting to "nobody is
      // listening" hands authorship back to play's own surfaces
      // rather than leaving the loop mute until the socket returns.
      roomListening = false;
      if (!closed) schedule(open, reconnectDelayMs);
    });
    next.on("error", () => next.close());
  };
  open();

  return {
    narrate(text, options) {
      const trimmed = text.trim();
      if (trimmed.length === 0) {
        return Promise.reject(new Error("clankie_speech_empty: nothing to say"));
      }
      if (trimmed.length > PLAY_NARRATION_MAX_CHARS) {
        return Promise.reject(
          new Error(`clankie_speech_too_long: ${String(PLAY_NARRATION_MAX_CHARS)} characters is the bound`),
        );
      }
      if (socket === null || socket.readyState !== OPEN) {
        // Refuse rather than queue: a line about a wall he bumped into is worth
        // nothing thirty seconds later, and play deserves to learn that
        // the body is not reachable instead of believing it spoke.
        return Promise.reject(
          new Error(
            "clankie_speech_unavailable: the active Discord body is not reachable on the play voice seam",
          ),
        );
      }
      const deliveryId = options?.deliveryId?.trim();
      const message: PlayNarrate = {
        schemaVersion: PLAY_VOICE_SCHEMA_VERSION,
        type: "narrate",
        text: trimmed,
        ...(deliveryId === undefined || deliveryId.length === 0 ? {} : { deliveryId }),
        ...(options?.respond === undefined ? {} : { respond: options.respond }),
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
    get roomListening() {
      return roomListening;
    },
    get connected() {
      return socket !== null && socket.readyState === OPEN;
    },
    close() {
      closed = true;
      listeners.clear();
      roomListening = false;
      socket?.close();
      socket = null;
    },
  };
}

function defaultConnect(url: string, token: string): PlayVoiceSocket {
  return new WebSocket(url, {
    headers: { authorization: `Bearer ${token}` },
  }) as unknown as PlayVoiceSocket;
}

function safeJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}
