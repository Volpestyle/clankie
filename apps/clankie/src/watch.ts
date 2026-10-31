import type { SettingsStore } from "@clankie/settings";

/**
 * Watch, the step below Off (ADR 0307). Clankie keeps reading sessions and
 * transcripts and showing them, and changes nothing: no model turn, no hire,
 * no message into a worker, no pane closed, no tracker write. Every write path
 * asks here at the moment it would act, so turning Watch on stops work that
 * was already scheduled.
 */
export const WATCH_REFUSAL =
  "Clankie is only watching, so he changes nothing. Pick a level other than Watch to let him act.";

/** Said when a turn would start: nothing reaches a model provider while watching. */
export const WATCH_TURN_REFUSAL =
  "Clankie is only watching, so he doesn't think, answer or act, and nothing goes to an AI model. Pick a level other than Watch to talk with him.";

export class WatchingError extends Error {
  public readonly code = "watching";
  public constructor(message: string = WATCH_REFUSAL) {
    super(message);
    this.name = "WatchingError";
  }
}

export interface WatchGate {
  /** True while the owner has Clankie only watching. Unreadable settings read as watching. */
  watching(): Promise<boolean>;
  /** Throws {@link WatchingError} with `message` while watching. */
  refuse(message?: string): Promise<void>;
}

export function createWatchGate(settings: Pick<SettingsStore, "load">): WatchGate {
  const watching = async (): Promise<boolean> => {
    try {
      return (await settings.load()).autonomy?.watch === true;
    } catch {
      // Fail closed: a write that cannot confirm Clankie may act does not act.
      return true;
    }
  };
  return {
    watching,
    refuse: async (message) => {
      if (await watching()) throw new WatchingError(message);
    },
  };
}
