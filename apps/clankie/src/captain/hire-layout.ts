import { createHash } from "node:crypto";
import { z } from "zod";
import type { PreparedCommandTab } from "./prepared-native-host.ts";

const Tokens = z.record(z.string(), z.string()).default({});
const Workspace = z.object({
  workspace_id: z.string().min(1),
  label: z.string(),
  number: z.number(),
  tokens: Tokens,
  worktree: z
    .object({
      repo_key: z.string(),
      repo_root: z.string(),
      repo_name: z.string(),
      is_linked_worktree: z.boolean(),
    })
    .optional(),
});
const Snapshot = z.object({
  result: z.object({
    snapshot: z.object({
      workspaces: z.array(Workspace),
      tabs: z.array(z.object({ tab_id: z.string(), workspace_id: z.string(), label: z.string() })),
      panes: z.array(
        z.object({
          pane_id: z.string(),
          workspace_id: z.string(),
          tab_id: z.string(),
          cwd: z.string().optional(),
          tokens: Tokens,
        }),
      ),
    }),
  }),
});
const REPO = "clankie_repo";
const PIPELINE = "clankie_pipeline";
const SOURCE = "clankie-hire-layout";
export class HireLayoutUnconfirmed extends Error {
  readonly paneId: string | undefined;
  constructor(detail: string, paneId?: string) {
    super(detail);
    this.paneId = paneId;
  }
}
interface HireLayoutInput {
  readonly cwd: string;
  readonly label: string;
  readonly paneLabel?: string;
  readonly pipeline?: string;
  readonly placement?: "new-tab" | "split";
  readonly env?: Readonly<Record<string, string>>;
  readonly command?: readonly string[];
}
type Run = (args: readonly string[]) => Promise<string>;

/** One runner per bound Herdr server; serialize its new allocations, never existing panes. */
export function createHireLayout(run: Run, commandTab?: (input: PreparedCommandTab) => Promise<string>) {
  let pending: Promise<unknown> = Promise.resolve();
  const snapshot = async () => Snapshot.parse(JSON.parse(await run(["api", "snapshot"]))).result.snapshot;
  const allocate = async (input: HireLayoutInput): Promise<string> => {
    if (input.placement === "split" && !input.pipeline)
      throw new Error(
        "Split placement requires a named pipeline; provide pipeline or choose new-tab. No pane was opened.",
      );
    const envArgs = Object.entries(input.env ?? {}).flatMap(([key, value]) => ["--env", `${key}=${value}`]);
    let repo: { key: string; cwd: string; label: string };
    try {
      const source = z
        .object({
          result: z.object({
            source: z.object({ repo_key: z.string(), repo_root: z.string(), repo_name: z.string() }),
          }),
        })
        .parse(JSON.parse(await run(["worktree", "list", "--cwd", input.cwd]))).result.source;
      repo = { key: source.repo_key, cwd: source.repo_root, label: source.repo_name };
    } catch (error) {
      if (!(error instanceof Error) || !/not_git_worktree/u.test(error.message)) throw error;
      // Non-Git directories have no repo identity. Exact host cwd is the key;
      // labels and another client's focus never establish membership.
      repo = {
        key: `directory:${input.cwd}`,
        cwd: input.cwd,
        label:
          input.cwd
            .replace(/[\\/]+$/u, "")
            .split(/[\\/]/u)
            .at(-1) || input.cwd,
      };
    }
    const repoToken = createHash("sha256").update(repo.key).digest("hex");
    const pipelineToken =
      input.pipeline === undefined ? undefined : createHash("sha256").update(input.pipeline).digest("hex");
    let current = await snapshot();
    const candidates = current.workspaces.filter(
      (ws) => ws.worktree?.repo_key === repo.key || ws.tokens[REPO] === repoToken,
    );
    // Ordinary hand-created workspaces have no worktree membership in Herdr's
    // snapshot. Reuse only a uniformly observed repo, never a mixed legacy lane.
    const observed = new Map<string, Promise<string | undefined>>();
    const keyFor = (cwd: string) => {
      let value = observed.get(cwd);
      if (!value) {
        value = run(["worktree", "list", "--cwd", cwd])
          .then(
            (raw) =>
              z
                .object({ result: z.object({ source: z.object({ repo_key: z.string() }) }) })
                .parse(JSON.parse(raw)).result.source.repo_key,
          )
          .catch((error: unknown) =>
            error instanceof Error && /not_git_worktree/u.test(error.message)
              ? `directory:${cwd}`
              : undefined,
          );
        observed.set(cwd, value);
      }
      return value;
    };
    if (!candidates.length) {
      for (const ws of current.workspaces) {
        if (ws.worktree || ws.tokens[REPO]) continue;
        const members = current.panes.filter((p) => p.workspace_id === ws.workspace_id);
        if (!members.length || members.some((p) => !p.cwd)) continue;
        const keys = await Promise.all(members.map((p) => keyFor(p.cwd!)));
        if (keys.every((key) => key === repo.key)) candidates.push(ws);
      }
    }
    candidates.sort(
      (a, b) =>
        Number(a.worktree?.is_linked_worktree ?? false) - Number(b.worktree?.is_linked_worktree ?? false) ||
        a.number - b.number,
    );
    let workspace = candidates[0];
    if (!workspace) {
      const created = z
        .object({ result: z.object({ workspace: Workspace, tab: z.object({ tab_id: z.string() }) }) })
        .parse(
          JSON.parse(
            await run(["workspace", "create", "--cwd", repo.cwd, "--label", repo.label, "--no-focus"]),
          ),
        ).result;
      workspace = created.workspace;
      // Only this newly created root tab is renamed; it stays separate from hires.
      await run(["tab", "rename", created.tab.tab_id, "Clankie"]);
      await run([
        "workspace",
        "report-metadata",
        workspace.workspace_id,
        "--source",
        SOURCE,
        "--token",
        `${REPO}=${repoToken}`,
      ]);
      current = await snapshot();
    }
    const tabs =
      input.pipeline === undefined
        ? []
        : current.tabs.filter(
            (t) => t.workspace_id === workspace!.workspace_id && t.label === input.pipeline,
          );
    if (tabs.length > 1)
      throw new Error(
        "Several tabs have this pipeline name; choose an unambiguous pipeline. No pane was opened.",
      );
    const pipeline = tabs[0];
    let paneId: string;
    if (pipeline) {
      if (input.placement !== "split")
        throw new Error("This pipeline tab already exists; use split to join it. No pane was opened.");
      const members = current.panes.filter((p) => p.tab_id === pipeline.tab_id);
      if (
        !members.length ||
        members.some((p) => p.tokens[PIPELINE] !== pipelineToken || p.tokens[REPO] !== repoToken)
      )
        throw new Error("The named tab is not a verified hire pipeline; existing panes were left untouched.");
      if (input.command)
        throw new Error(
          "Prepared native initial-command hires require a new tab; pipeline splitting is unsupported. Existing panes were left untouched.",
        );
      const tail = members.at(-1)!;
      const layout = z
        .object({
          result: z.object({
            layout: z.object({
              panes: z.array(
                z.object({ pane_id: z.string(), rect: z.object({ width: z.number(), height: z.number() }) }),
              ),
            }),
          }),
        })
        .parse(JSON.parse(await run(["pane", "layout", "--pane", tail.pane_id]))).result.layout;
      const area = layout.panes.find((p) => p.pane_id === tail.pane_id)?.rect;
      if (!area) throw new Error("Pipeline tail disappeared; no pane was opened.");
      paneId = await createPane(
        async () =>
          z
            .object({ result: z.object({ pane: z.object({ pane_id: z.string().min(1) }) }) })
            .parse(
              JSON.parse(
                await run([
                  "pane",
                  "split",
                  "--pane",
                  tail.pane_id,
                  "--direction",
                  area.width > area.height * 2 ? "right" : "down",
                  "--cwd",
                  input.cwd,
                  "--no-focus",
                  ...envArgs,
                ]),
              ),
            ).result.pane.pane_id,
      );
    } else if (input.command) {
      if (!commandTab) throw new Error("Native initial-command pane creation unavailable");
      paneId = await createPane(() =>
        commandTab({
          cwd: input.cwd,
          label: input.pipeline ?? input.label,
          workspaceId: workspace.workspace_id,
          command: input.command!,
          ...(input.env === undefined ? {} : { env: input.env }),
        }),
      );
    } else {
      paneId = await createPane(
        async () =>
          z
            .object({ result: z.object({ root_pane: z.object({ pane_id: z.string().min(1) }) }) })
            .parse(
              JSON.parse(
                await run([
                  "tab",
                  "create",
                  "--workspace",
                  workspace.workspace_id,
                  "--cwd",
                  input.cwd,
                  "--label",
                  input.pipeline ?? input.label,
                  "--no-focus",
                  ...envArgs,
                ]),
              ),
            ).result.root_pane.pane_id,
      );
    }
    // Failure after creation must be reconciled, never retried with a new pane.
    try {
      await run(["pane", "rename", paneId, input.paneLabel ?? input.label]);
      if (input.pipeline)
        await run([
          "pane",
          "report-metadata",
          paneId,
          "--source",
          SOURCE,
          "--token",
          `${REPO}=${repoToken}`,
          "--token",
          `${PIPELINE}=${pipelineToken}`,
        ]);
    } catch {
      throw new HireLayoutUnconfirmed(
        `Hire layout creation unconfirmed at ${paneId}; inspect Herdr before retrying. No existing pane was closed.`,
        paneId,
      );
    }
    return paneId;
  };
  return (input: HireLayoutInput): Promise<string> => {
    const next = pending.catch(() => undefined).then(() => allocate(input));
    pending = next;
    return next;
  };
}

async function createPane(effect: () => Promise<string>): Promise<string> {
  try {
    return await effect();
  } catch (error) {
    throw new HireLayoutUnconfirmed(
      `Native pane creation unconfirmed; inspect Herdr before retrying: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}
