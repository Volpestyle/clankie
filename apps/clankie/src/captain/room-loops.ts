import { createHash } from "node:crypto";
import type { DiscordSessionAccess } from "./room-skill-tools.ts";

/**
 * ADR 0291: a Pi text room answers in one durable loop per exact grant instead
 * of a fresh session per message. Rollout only: `CLANKIE_ROOM_LOOP` names `all`
 * or comma-separated `guildId:channelId` targets; absent keeps ADR 0229.
 */
export class RoomLoops {
  private readonly all: boolean;
  private readonly targets: ReadonlySet<string>;
  private readonly tails = new Map<string, Promise<void>>();
  private readonly holders = new Map<string, { current: DiscordSessionAccess }>();
  private readonly shown = new Map<string, Set<string>>();

  public constructor(setting: string | undefined) {
    const entries = (setting ?? "")
      .split(",")
      .map((entry) => entry.trim())
      .filter(Boolean);
    this.all = entries.includes("all");
    this.targets = new Set(entries);
  }

  public accepts(targetId: string): boolean {
    return this.all || this.targets.has(targetId);
  }

  /** One loop per room session and grant fingerprint; a changed grant starts another. */
  public key(sessionKey: string, grant: string): string {
    return `${sessionKey}:loop:${createHash("sha256").update(grant).digest("hex").slice(0, 16)}`;
  }

  /**
   * The loop's session is built once, but each turn acts for its own sender.
   * Turns in one loop run one at a time, so the holder always names the running one.
   */
  public access(key: string, current: DiscordSessionAccess): DiscordSessionAccess {
    let holder = this.holders.get(key);
    if (holder === undefined) this.holders.set(key, (holder = { current }));
    holder.current = current;
    const live = holder;
    // Getters read the running turn's grant; an absent optional field reads as undefined.
    return {
      get privateContext() {
        return live.current.privateContext;
      },
      get skillGrant() {
        return live.current.skillGrant;
      },
      get actorId() {
        return live.current.actorId;
      },
      get home() {
        return live.current.home;
      },
      get skillRoot() {
        return live.current.skillRoot;
      },
      authorize: () => live.current.authorize(),
      authorBindings: async () => (await live.current.authorBindings?.()) ?? [],
    } as DiscordSessionAccess;
  }

  /** Context visuals this loop has already been shown, by source message id. */
  public shownVisuals(key: string): Set<string> {
    let shown = this.shown.get(key);
    if (shown === undefined) this.shown.set(key, (shown = new Set()));
    return shown;
  }

  /** Speakers take turns: each turn of a loop starts after the previous one settles. */
  public async serialize<T>(key: string, work: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(key) ?? Promise.resolve();
    let release!: () => void;
    const tail = new Promise<void>((resolve) => (release = resolve));
    this.tails.set(key, tail);
    try {
      await previous;
      return await work();
    } finally {
      release();
      if (this.tails.get(key) === tail) this.tails.delete(key);
    }
  }
}
