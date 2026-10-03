import {
  BodyVoiceReconcileRequestSchema,
  type BodyVoiceReconcileRequest,
  type BodyVoiceReconcileResult,
  type BodyVoiceSubject,
} from "@clankie/protocol";
import type { IncomingMessage, ServerResponse } from "node:http";

export interface BodyVoiceReconcilePorts {
  readonly subject: BodyVoiceSubject;
  readonly presenceSessionId: string;
  readonly userId: string;
  current(): boolean;
  authorize(request: BodyVoiceReconcileRequest): Promise<boolean>;
  /** Trusted local cleanup; must refuse a different ongoing room/stay. */
  stopLocal(request: BodyVoiceReconcileRequest): Promise<boolean>;
  subscribe(listener: (event: { t: string; d: Record<string, unknown> }) => void): () => void;
  send(payload: { op: number; d: Record<string, unknown> }): boolean;
}

/** Fresh gateway receipts, never absence inferred from a new process's empty local maps. */
export async function reconcileBodyVoice(
  request: BodyVoiceReconcileRequest,
  ports: BodyVoiceReconcilePorts,
  deadlineMs = 10_000,
): Promise<BodyVoiceReconcileResult | undefined> {
  if (JSON.stringify(request.subject) !== JSON.stringify(ports.subject) || !ports.current()) return undefined;
  const guilds = new Set(request.stays.map((stay) => stay.target.guildId));
  const streams = new Set(
    request.stays
      .filter((stay) => stay.kind === "publish")
      .map((stay) => `guild:${stay.target.guildId}:${stay.target.channelId}:${ports.userId}`),
  );
  if (request.stays.some((stay) => stay.target.transportKind !== ports.subject.transportKind))
    return undefined;
  const left = new Set<string>();
  const deleted = new Set<string>();
  let attempted = false;
  let resolve!: (value: boolean) => void;
  const observed = new Promise<boolean>((settle) => {
    resolve = settle;
  });
  const settled = () => {
    if (
      attempted &&
      [...guilds].every((guild) => left.has(guild)) &&
      [...streams].every((key) => deleted.has(key))
    )
      resolve(true);
  };
  const unsubscribe = ports.subscribe(({ t, d }) => {
    if (!attempted || !ports.current()) return;
    if (
      t === "VOICE_STATE_UPDATE" &&
      d.user_id === ports.userId &&
      d.channel_id === null &&
      typeof d.guild_id === "string" &&
      guilds.has(d.guild_id)
    )
      left.add(d.guild_id);
    if (t === "STREAM_DELETE" && typeof d.stream_key === "string" && streams.has(d.stream_key))
      deleted.add(d.stream_key);
    settled();
  });
  const timer = setTimeout(() => resolve(false), deadlineMs);
  timer.unref();
  try {
    if (!(await ports.authorize(request)) || !ports.current()) return undefined;
    attempted = true;
    if (!(await ports.stopLocal(request))) return undefined;
    if (!(await ports.authorize(request)) || !ports.current()) return undefined;
    for (const key of streams) if (!ports.send({ op: 19, d: { stream_key: key } })) return undefined;
    for (const guild of guilds)
      if (!ports.send({ op: 4, d: { guild_id: guild, channel_id: null, self_mute: true, self_deaf: true } }))
        return undefined;
    settled();
    if (!(await observed) || !ports.current() || !(await ports.authorize(request)) || !ports.current())
      return undefined;
    return {
      nonce: request.nonce,
      subject: ports.subject,
      presenceSessionId: ports.presenceSessionId,
      confirmedStayIds: request.stays.map((stay) => stay.stayId),
    };
  } finally {
    clearTimeout(timer);
    unsubscribe();
  }
}

export function tryHandleBodyVoiceReconcile(
  request: IncomingMessage,
  response: ServerResponse,
  ports: () => BodyVoiceReconcilePorts | undefined,
): boolean {
  if (request.method !== "POST" || (request.url ?? "").split("?")[0] !== "/voice/reconcile") return false;
  const chunks: Buffer[] = [];
  let bytes = 0;
  request.on("data", (chunk: Buffer) => {
    bytes += chunk.length;
    if (bytes <= 128 * 1024) chunks.push(chunk);
  });
  request.on("end", () => {
    void (async () => {
      try {
        if (bytes > 128 * 1024) throw new Error("request_too_large");
        const input = BodyVoiceReconcileRequestSchema.parse(
          JSON.parse(Buffer.concat(chunks).toString("utf8")),
        );
        const current = ports();
        const result = current === undefined ? undefined : await reconcileBodyVoice(input, current);
        response.writeHead(result === undefined ? 409 : 200, { "content-type": "application/json" });
        response.end(JSON.stringify(result ?? { error: "voice_termination_unconfirmed" }));
      } catch {
        response.writeHead(409);
        response.end(JSON.stringify({ error: "voice_termination_unconfirmed" }));
      }
    })();
  });
  return true;
}
