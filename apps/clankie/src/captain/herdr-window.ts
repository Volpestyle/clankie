import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { basename, dirname } from "node:path";
import { promisify } from "node:util";
import { SEAT_LABEL, type HerdrCoreSeats, type HerdrCoreTerminal } from "./herdr-core-seats.ts";

// Where Clankie's hires sit in the Herdr desktop app, and what the window calls them.
// The core places a terminal by its `herdr.space` and `herdr.tab` labels, but those are
// ids: a space or tab the window doesn't know yet is made unnamed, so it shows the
// first terminal's folder (`wt-clankie-9c9571`) and a number (`1`). Clankie gives each
// project its own space and each hire its own tab, and names them through the window's
// own command line (`herdr-app do tab.rename`), which only an open window answers. The
// names wait on the terminals as labels, so a window opened later is named on the next
// hire. Names the owner gave are never overwritten.

/** What the window should call a hire's tab. */
export const TAB_NAME_LABEL = "clankie.tab-name";
/** What the window should call a hire's project space. */
export const SPACE_NAME_LABEL = "clankie.space-name";
/** Panes a shared (pipeline) tab holds before the next hire opens its next tab. */
export const PANES_PER_TAB = 3;
const ID_PREFIX = "clankie-";
const APP_MS = 5_000;
const GIT_MS = 2_000;

export interface HerdrWindowTab {
  readonly id: string;
  readonly name: string;
}
export interface HerdrWindowSpace {
  readonly id: string;
  readonly name: string;
  readonly folder?: string;
  readonly tabs: readonly HerdrWindowTab[];
}

export interface HerdrWindow {
  /** The open window's spaces and tabs, or undefined when no window answers. */
  ls(): Promise<readonly HerdrWindowSpace[] | undefined>;
  /** Renames a space or tab the window shows; false when it couldn't. */
  rename(kind: "space" | "tab", id: string, name: string): Promise<boolean>;
}

export interface HerdrWindowOptions {
  /** The desktop app's command line; `herdr-app` on PATH by default. */
  readonly appCommand?: string;
  readonly env?: NodeJS.ProcessEnv;
}

export function createHerdrWindow(options: HerdrWindowOptions = {}): HerdrWindow {
  const app = async (args: readonly string[]): Promise<unknown> => {
    const { stdout } = await promisify(execFile)(options.appCommand ?? "herdr-app", [...args], {
      timeout: APP_MS,
      env: options.env ?? process.env,
    });
    return JSON.parse(stdout) as unknown;
  };
  return {
    async ls() {
      try {
        const listed = (await app(["ls"])) as { spaces?: unknown };
        if (!Array.isArray(listed.spaces)) return undefined;
        return (listed.spaces as Record<string, unknown>[]).flatMap((space) =>
          typeof space.id === "string" && typeof space.name === "string"
            ? [
                {
                  id: space.id,
                  name: space.name,
                  ...(typeof space.folder === "string" ? { folder: space.folder } : {}),
                  tabs: (Array.isArray(space.tabs) ? (space.tabs as Record<string, unknown>[]) : []).flatMap(
                    (tab) =>
                      typeof tab.id === "string" && typeof tab.name === "string"
                        ? [{ id: tab.id, name: tab.name }]
                        : [],
                  ),
                },
              ]
            : [],
        );
      } catch {
        // No window open, or no desktop app on this machine: nothing to name now.
        return undefined;
      }
    },
    async rename(kind, id, name) {
      try {
        const reply = (await app(["do", `${kind}.rename`, JSON.stringify({ id, name })])) as {
          error?: unknown;
        };
        return reply.error === undefined;
      } catch {
        return false;
      }
    },
  };
}

/** A hire's place: its project's space and its own tab (or its pipeline's next open one). */
export interface HirePlacement {
  readonly space: string;
  readonly spaceName: string;
  readonly tab: string;
  readonly tabName: string;
}

/** The project a hire works in, for its space: the project's name, else its repository's. */
export async function hireProject(cwd: string, project?: string): Promise<string> {
  const named = project?.trim();
  if (named) return named;
  try {
    // A worktree's common git directory is its main checkout's `.git`, named for the repo.
    const { stdout } = await promisify(execFile)(
      "git",
      ["-C", cwd, "rev-parse", "--path-format=absolute", "--git-common-dir"],
      { timeout: GIT_MS },
    );
    const common = stdout.trim();
    if (common.length > 0) return basename(basename(common) === ".git" ? dirname(common) : common);
  } catch {
    // Not a git checkout: the folder names it.
  }
  return basename(cwd) || "Workers";
}

/**
 * Where a new hire goes. Each project gets one space (`clankie workers`), each hire its own
 * tab named for it; a pipeline's hires share a tab, `PANES_PER_TAB` at a time, then the next.
 */
export function placeHire(
  terminals: readonly HerdrCoreTerminal[],
  request: { readonly project: string; readonly tabName: string; readonly pipeline?: string },
): HirePlacement {
  const slug =
    request.project
      .toLowerCase()
      .replaceAll(/[^a-z0-9]+/gu, "-")
      .replaceAll(/^-+|-+$/gu, "") || createHash("sha256").update(request.project).digest("hex").slice(0, 8);
  const space = `${ID_PREFIX}${slug}`;
  const spaceName = `${request.project} workers`;
  if (request.pipeline === undefined)
    return { space, spaceName, tab: `${ID_PREFIX}${randomUUID().slice(0, 8)}`, tabName: request.tabName };
  const base = `${space}-${createHash("sha256").update(request.pipeline).digest("hex").slice(0, 8)}`;
  for (let number = 1; ; number += 1) {
    const tab = number === 1 ? base : `${base}-${number}`;
    const members = terminals.filter(
      (terminal) => terminal.state === "live" && terminal.labels["herdr.tab"] === tab,
    ).length;
    if (members < PANES_PER_TAB)
      return {
        space,
        spaceName,
        tab,
        tabName: number === 1 ? request.pipeline : `${request.pipeline} · ${number}`,
      };
  }
}

/**
 * Names Clankie's spaces and tabs in the open window from the names their terminals carry.
 * A tab is renamed only while it shows its number, and a space only while it shows a
 * folder's name, so a name the owner chose stays. Answers how many named tabs the window
 * doesn't show yet (it places a new terminal on its next listing), or undefined when no
 * window answers.
 */
export async function nameClankieTabs(
  seats: Pick<HerdrCoreSeats, "list">,
  window: HerdrWindow,
): Promise<number | undefined> {
  const terminals = (await seats.list()).filter(
    (terminal) => terminal.state === "live" && terminal.labels[SEAT_LABEL] !== undefined,
  );
  const tabNames = new Map<string, string>();
  const spaceNames = new Map<string, string>();
  const folders = new Map<string, Set<string>>();
  for (const terminal of terminals) {
    const { labels } = terminal;
    const tab = labels["herdr.tab"];
    const space = labels["herdr.space"];
    if (tab !== undefined && labels[TAB_NAME_LABEL]) tabNames.set(tab, labels[TAB_NAME_LABEL]);
    if (space !== undefined && labels[SPACE_NAME_LABEL]) {
      spaceNames.set(space, labels[SPACE_NAME_LABEL]);
      const seen = folders.get(space) ?? new Set<string>();
      if (terminal.cwd !== undefined) seen.add(basename(terminal.cwd));
      folders.set(space, seen);
    }
  }
  if (tabNames.size === 0 && spaceNames.size === 0) return 0;
  const spaces = await window.ls();
  if (spaces === undefined) return undefined;
  const shown = new Set(spaces.flatMap((space) => space.tabs.map((tab) => tab.id)));
  for (const space of spaces) {
    const name = spaceNames.get(space.id);
    // Unnamed, the window calls a space after a terminal's folder.
    const automatic =
      space.name === "~" ||
      space.name === space.id ||
      (space.folder !== undefined && space.name === basename(space.folder)) ||
      (folders.get(space.id)?.has(space.name) ?? false);
    if (name !== undefined && space.name !== name && automatic) await window.rename("space", space.id, name);
    for (const tab of space.tabs) {
      const tabName = tabNames.get(tab.id);
      // Unnamed, the window calls a tab by its number.
      if (tabName !== undefined && tab.name !== tabName && /^\d+$/u.test(tab.name))
        await window.rename("tab", tab.id, tabName);
    }
  }
  return [...tabNames.keys()].filter((tab) => !shown.has(tab)).length;
}
