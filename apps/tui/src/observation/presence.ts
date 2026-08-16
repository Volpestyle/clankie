/**
 * Clankie presence for the status bar: a small read-only poll of the clankie
 * service's presence-status projection. Shows the live presence phase
 * (`present`, `voice_active`, …) or the reason nothing can be shown.
 */
import { z } from "zod";

/** Read-only operator projection of the published presence phase. */
export const PRESENCE_STATUS_PATH = "/v1/discord/presence-status";

const PresenceStatusSchema = z.object({
  schemaVersion: z.literal(1),
  sessions: z.array(
    z.object({
      phase: z.string().min(1),
      gatewayConnected: z.boolean(),
      voiceGuildCount: z.number().int().nonnegative(),
      activityCount: z.number().int().nonnegative(),
    }),
  ),
});

/** Phases that count as a live, acting presence. */
const LIVE_PRESENCE_PHASES: ReadonlySet<string> = new Set(["present", "voice_active", "go_live_active"]);

export interface PresenceSnapshot {
  readonly phase: string;
}

export interface PresencePollerOptions {
  readonly baseUrl: string;
  readonly operatorToken?: string | undefined;
  readonly fetchImpl?: typeof fetch;
  readonly pollIntervalMs?: number;
}

const POLL_INTERVAL_MS = 5_000;

export class PresencePoller {
  private readonly baseUrl: string;
  private readonly operatorToken: string | undefined;
  private readonly fetchImpl: typeof fetch;
  private readonly pollIntervalMs: number;
  private current: PresenceSnapshot = { phase: "checking" };
  private timer: ReturnType<typeof setInterval> | undefined;

  public constructor(options: PresencePollerOptions) {
    this.baseUrl = options.baseUrl;
    this.operatorToken = options.operatorToken?.trim() || undefined;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.pollIntervalMs = options.pollIntervalMs ?? POLL_INTERVAL_MS;
  }

  public get snapshot(): PresenceSnapshot {
    return this.current;
  }

  public start(onChange: () => void): void {
    if (this.timer !== undefined) return;
    const tick = (): void => {
      void this.poll().then((changed) => {
        if (changed) onChange();
      });
    };
    tick();
    this.timer = setInterval(tick, this.pollIntervalMs);
    this.timer.unref();
  }

  public stop(): void {
    if (this.timer !== undefined) clearInterval(this.timer);
    this.timer = undefined;
  }

  public async poll(): Promise<boolean> {
    const before = this.current.phase;
    this.current = await this.read();
    return this.current.phase !== before;
  }

  private async read(): Promise<PresenceSnapshot> {
    if (this.operatorToken === undefined) return { phase: "authentication unavailable" };
    try {
      const response = await this.fetchImpl(new URL(PRESENCE_STATUS_PATH, this.baseUrl), {
        headers: { authorization: `Bearer ${this.operatorToken}` },
        redirect: "error",
        signal: AbortSignal.timeout(2_000),
      });
      if (response.status === 401 || response.status === 403) return { phase: "authentication failed" };
      if (!response.ok) return { phase: "service unavailable" };
      const parsed = PresenceStatusSchema.safeParse(await response.json());
      if (!parsed.success) return { phase: "status unavailable" };
      const live = parsed.data.sessions.filter((session) => LIVE_PRESENCE_PHASES.has(session.phase));
      const session = live[0] ?? parsed.data.sessions[0];
      return session === undefined ? { phase: "not connected" } : { phase: session.phase };
    } catch {
      return { phase: "unreachable" };
    }
  }
}
