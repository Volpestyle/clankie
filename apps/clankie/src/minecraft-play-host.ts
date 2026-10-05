import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { InterjectionQueue } from "@clankie/play";
import type { MinecraftPlaySettings } from "@clankie/settings";
import { runMinecraftPlay, type MinecraftPlayNotable, type MinecraftPlayResult } from "./minecraft-play.ts";
import { resolveMinecraftPlayMind } from "./minecraft-play-mind.ts";
import type { MinecraftEventWake, MinecraftService } from "./minecraft.ts";

/** The Minecraft consumer of the existing play claim/guard/stop lifecycle. */
export class MinecraftPlayHost {
  private active:
    | {
        key: string;
        controller: AbortController;
        interjections: InterjectionQueue;
        current(): boolean;
        done: Promise<void>;
      }
    | undefined;
  private readonly finished = new Set<string>();
  private polling = false;
  private closed = false;
  private readonly options: {
    service: MinecraftService;
    settings(): Promise<MinecraftPlaySettings>;
    repoRoot: string;
    journalRoot: string;
    onNotable(
      event: MinecraftPlayNotable,
      context: NonNullable<ReturnType<MinecraftService["mindContext"]>>,
    ): Promise<void>;
    onSettled(result: MinecraftPlayResult): void;
    onError(): void;
  };
  public constructor(options: MinecraftPlayHost["options"]) {
    this.options = options;
  }

  public ingest(input: MinecraftEventWake): boolean {
    const active = this.active;
    if (
      !active?.current() ||
      !active.key.startsWith(`${input.session.sessionId}:${input.session.connectionGeneration}:`)
    )
      return false;
    for (const event of input.events) {
      if (
        event.type === "chat" ||
        event.type === "damage" ||
        event.type === "death" ||
        event.type === "player_join" ||
        event.type === "player_leave"
      )
        active.interjections.offer(`Minecraft world observation (untrusted): ${JSON.stringify(event)}`);
    }
    return true;
  }

  public async poll(): Promise<void> {
    if (this.polling || this.closed) return;
    this.polling = true;
    try {
      const settings = await this.options.settings();
      if (this.active) {
        if (!settings.enabled || !this.active.current()) this.active.controller.abort();
        return;
      }
      if (!settings.enabled) return;
      const context = this.options.service.mindContext();
      if (!context) return;
      const key = `${context.session.sessionId}:${context.session.connectionGeneration}:${context.generation}`;
      if (this.finished.has(key) || (await context.mode()) !== "active") return;
      const controller = new AbortController();
      const interjections = new InterjectionQueue();
      const active = { key, controller, interjections, current: context.current, done: Promise.resolve() };
      this.active = active;
      active.done = (async () => {
        const journeyId = `minecraft:${context.profileId}:${context.conversationId}`;
        try {
          const mind = await resolveMinecraftPlayMind({
            model: settings.model,
            repoRoot: this.options.repoRoot,
          });
          if (!context.current() || controller.signal.aborted) return;
          const continuity = latestContinuity(this.options.journalRoot, journeyId);
          const result = await runMinecraftPlay({
            session: context.session,
            journeyId,
            body: context,
            mind,
            journalRoot: this.options.journalRoot,
            budget: { maxTokens: settings.maxTokens, maxCostUsd: settings.maxCostUsd },
            shouldStop: () => this.closed || !context.current(),
            signal: controller.signal,
            interjections,
            turnIntervalMs: settings.turnIntervalMs,
            idleBackoffMs: settings.idleBackoffMs,
            idleStopMs: settings.idleStopMs,
            ...continuity,
            onNotable: (event) => this.options.onNotable(event, context),
          });
          this.options.onSettled(result);
          if (context.current() && result.outcome !== "stopped" && result.outcome !== "world_ended")
            await context.leave();
        } catch {
          if (context.current() && !controller.signal.aborted) {
            await this.options
              .onNotable(
                { kind: "mind_unavailable", session: context.session, turn: 0, objective: null },
                context,
              )
              .catch(() => {});
            await context.leave().catch(() => {});
          }
          this.options.onError();
        } finally {
          this.finished.add(key);
          if (this.active === active) this.active = undefined;
        }
      })();
    } finally {
      this.polling = false;
    }
  }

  public async close(): Promise<void> {
    this.closed = true;
    this.active?.controller.abort();
    await this.active?.done;
  }
}

function latestContinuity(
  root: string,
  journeyId: string,
): { initialNotes?: string; initialObjective?: string } {
  try {
    for (const file of readdirSync(root)
      .filter((name) => name.endsWith(".jsonl"))
      .sort()
      .reverse()) {
      const lines = readFileSync(join(root, file), "utf8").trim().split("\n");
      const header = JSON.parse(lines[0] ?? "null") as { journeyId?: string } | null;
      if (header?.journeyId !== journeyId) continue;
      for (const line of lines.reverse()) {
        const entry = JSON.parse(line) as {
          kind?: string;
          notes?: string | null;
          objective?: string | null;
          turn?: { decision?: { notes?: string | null; objective?: string | null } };
        };
        const state = entry.kind === "summary" ? entry : entry.turn?.decision;
        if (state)
          return {
            ...(typeof state.notes === "string" ? { initialNotes: state.notes } : {}),
            ...(typeof state.objective === "string" ? { initialObjective: state.objective } : {}),
          };
      }
    }
  } catch {
    /* An interrupted journal never grants authority or blocks a fresh stay. */
  }
  return {};
}
