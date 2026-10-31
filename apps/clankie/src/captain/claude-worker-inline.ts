import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * A hired Claude seat without an installed plugin: the worker's MCP server and
 * hooks passed at launch (`--mcp-config`, and `hooks` in `--settings`) from the
 * worker files on that host. Locally that is this install's worker directory;
 * on a fleet machine, the copy `clankie herdr prepare` stages under
 * `~/.clankie/claude-plugin/worker`. Nothing is written to a Claude profile.
 *
 * Claude names a launch-time server `mcp__worker__*` instead of the plugin's
 * `mcp__plugin_clankie-worker_worker__*`, so a seat built from this allows
 * {@link CLAUDE_WORKER_INLINE_SERVER_RULE}.
 */
export const CLAUDE_WORKER_INLINE_SERVER = "worker";
export const CLAUDE_WORKER_INLINE_SERVER_RULE = `mcp__${CLAUDE_WORKER_INLINE_SERVER}`;

type HookEntry = Record<string, unknown> & { readonly command?: unknown };
type HookMatcher = Record<string, unknown> & { readonly hooks?: readonly HookEntry[] };
export type ClaudeWorkerHooks = Readonly<Record<string, readonly HookMatcher[]>>;

const PLUGIN_ROOT = "${CLAUDE_PLUGIN_ROOT}";

/** POSIX single-quoted word; hooks run under the host's shell. */
function quote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

/**
 * The worker's hooks with its root written in. A plugin hook also has
 * `CLAUDE_PLUGIN_ROOT` in its environment, which a settings hook lacks and
 * `root-lease-hook.sh` reads, so each command sets it first.
 */
export function claudeWorkerInlineHooks(
  workerRoot: string,
  source = readFileSync(join(workerRoot, "hooks", "hooks.json"), "utf8"),
): ClaudeWorkerHooks {
  const declared = (JSON.parse(source) as { hooks?: Record<string, HookMatcher[]> }).hooks ?? {};
  const prefix = `CLAUDE_PLUGIN_ROOT=${quote(workerRoot)} `;
  return Object.fromEntries(
    Object.entries(declared).map(([event, matchers]) => [
      event,
      matchers.map((matcher) => ({
        ...matcher,
        hooks: (matcher.hooks ?? []).map((hook) =>
          typeof hook.command === "string"
            ? { ...hook, command: prefix + hook.command.replaceAll(PLUGIN_ROOT, workerRoot) }
            : hook,
        ),
      })),
    ]),
  );
}

/** The `--mcp-config` JSON for the worker's own server. */
export function claudeWorkerInlineMcpConfig(workerRoot: string): string {
  return JSON.stringify({
    mcpServers: {
      [CLAUDE_WORKER_INLINE_SERVER]: {
        command: "node",
        args: [join(workerRoot, "bin", "swarm-mcp.mjs")],
        env: { CLAUDE_PLUGIN_ROOT: workerRoot },
      },
    },
  });
}
