import { join } from "node:path";

/**
 * Where Clankie looks for skills: one rule for the list he is offered and the
 * list he can actually load.
 *
 * Two lists used to exist. The TUI completed `/skill:` from five roots
 * including `~/.agents/skills`, while the captain's session loaded only the
 * two that ship in this repo — so every personal skill autocompleted, and the
 * message submitted, and `resolveOperatorPrompt` found no such skill and
 * passed the text through as an ordinary prompt. No skill, no error. The same
 * gap kept his own instructions hedging "load `herdr-lead` … when that skill
 * is present": it is present on disk, and it was never on his path.
 *
 * Order is precedence: `loadSkills` keeps the first skill of a given name and
 * reports the rest as collisions, so the skills that ship with this body win
 * over a personal skill that happens to share a name.
 *
 * Paths are returned whether or not they exist. Callers filter, because the
 * two consumers want opposite things from a missing one: the loader reports it
 * as a diagnostic, the catalog just skips it.
 */
export function clankieSkillRoots(input: {
  /** The checkout or installed release: the skills shipped with this body. */
  readonly repoRoot: string;
  /** Pi's agent directory, as `getAgentDir()` resolves it. */
  readonly agentDir: string;
  /** Home, for the roots shared with every other agent on this machine. */
  readonly home: string;
  /**
   * The workspace a session works in, when it has one. A workspace-scoped
   * conversation picks up the skills belonging to the code in front of him;
   * a boot-time catalog has no workspace yet and omits this.
   */
  readonly cwd?: string;
}): readonly string[] {
  return [
    join(input.repoRoot, ".pi", "skills"),
    join(input.repoRoot, ".agents", "skills"),
    join(input.repoRoot, ".agents", "dev-skills"),
    ...(input.cwd === undefined ? [] : [join(input.cwd, ".agents", "skills")]),
    join(input.agentDir, "skills"),
    join(input.home, ".agents", "skills"),
  ];
}
