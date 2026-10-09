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
const GRID = "clankie_grid";
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
  readonly group?: string;
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
    const group = input.pipeline ?? input.group ?? `${repo.label} workers`;
    const pipelineToken = createHash("sha256").update(group).digest("hex");
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
    const grouped = input.placement !== "new-tab";
    const tabs = current.tabs.filter((t) => t.workspace_id === workspace!.workspace_id);
    const matching = tabs.filter((t) => {
      const members = current.panes.filter((p) => p.tab_id === t.tab_id);
      return (
        members.length > 0 &&
        members.every(
          (p) =>
            p.tokens[PIPELINE] === pipelineToken && p.tokens[REPO] === repoToken && p.tokens[GRID] === "2x2",
        )
      );
    });
    if (input.pipeline && tabs.some((t) => t.label === group && !matching.includes(t)))
      throw new Error("The named tab is not a verified hire grid; existing panes were left untouched.");
    if (!grouped && input.pipeline && matching.length)
      throw new Error(
        "This pipeline tab already exists; omit placement or use split to join it. No pane was opened.",
      );
    // Fill the current verified group before creating its next numbered tab.
    const pipeline = grouped ? matching.at(-1) : undefined;
    const members = pipeline ? current.panes.filter((p) => p.tab_id === pipeline.tab_id) : [];
    if (members.length > 4)
      throw new Error("Hire grid exceeds four panes; existing panes were left untouched.");
    let target: string | undefined;
    let direction: "right" | "down" = "right";
    if (pipeline && members.length < 4) {
      const layout = z
        .object({
          result: z.object({
            layout: z.object({
              panes: z.array(
                z.object({
                  pane_id: z.string(),
                  rect: z.object({ x: z.number(), y: z.number(), width: z.number(), height: z.number() }),
                }),
              ),
            }),
          }),
        })
        .parse(JSON.parse(await run(["pane", "layout", "--pane", members[0]!.pane_id]))).result.layout;
      const panes = layout.panes;
      if (panes.length !== members.length || panes.some((p) => !members.some((m) => m.pane_id === p.pane_id)))
        throw new Error("Hire grid changed; no pane was opened.");
      const left = [...panes].sort((a, b) => a.rect.x - b.rect.x || a.rect.y - b.rect.y);
      const topLeft = left[0]!;
      const topRight = panes.find((p) => p.rect.x > topLeft.rect.x && p.rect.y === topLeft.rect.y);
      const bottomLeft = panes.find((p) => p.rect.x === topLeft.rect.x && p.rect.y > topLeft.rect.y);
      const valid =
        members.length === 1 ||
        (topRight !== undefined &&
          Math.abs(topLeft.rect.width - topRight.rect.width) <= 1 &&
          (members.length === 2
            ? topLeft.rect.height === topRight.rect.height
            : bottomLeft !== undefined &&
              bottomLeft.rect.width === topLeft.rect.width &&
              Math.abs(topLeft.rect.height - bottomLeft.rect.height) <= 1 &&
              topRight.rect.height === topLeft.rect.height + bottomLeft.rect.height));
      if (!valid) throw new Error("Hire grid is no longer 2x2; existing panes were left untouched.");
      target = members.length === 3 ? topRight!.pane_id : topLeft.pane_id;
      direction = members.length === 1 ? "right" : "down";
    }
    let tabLabel = input.pipeline ?? input.label;
    if (grouped) {
      let number = 1;
      tabLabel = group;
      while (tabs.some((t) => t.label === tabLabel)) tabLabel = `${group} · ${++number}`;
    }
    let paneId: string;
    if (target && !input.command) {
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
                  target!,
                  "--direction",
                  direction,
                  "--ratio",
                  "0.5",
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
          label: target ? `${group} · allocating` : tabLabel,
          workspaceId: workspace.workspace_id,
          command: input.command!,
          ...(input.env === undefined ? {} : { env: input.env }),
        }),
      );
      if (target) {
        // Only the newly created pane moves, from its own temporary tab. Same-tab
        // moves silently do nothing in Herdr; never rebuild a live tab's layout.
        try {
          paneId = z
            .object({
              result: z.object({ move_result: z.object({ pane: z.object({ pane_id: z.string().min(1) }) }) }),
            })
            .parse(
              JSON.parse(
                await run([
                  "pane",
                  "move",
                  paneId,
                  "--tab",
                  pipeline!.tab_id,
                  "--split",
                  direction,
                  "--target-pane",
                  target,
                  "--ratio",
                  "0.5",
                  "--no-focus",
                ]),
              ),
            ).result.move_result.pane.pane_id;
        } catch (error) {
          throw new HireLayoutUnconfirmed(
            `Hire grid move unconfirmed at ${paneId}; inspect Herdr before retrying: ${error instanceof Error ? error.message : String(error)}`,
            paneId,
          );
        }
      }
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
                  tabLabel,
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
      if (grouped)
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
          "--token",
          `${GRID}=2x2`,
        ]);
    } catch (error) {
      throw new HireLayoutUnconfirmed(
        `Hire layout creation unconfirmed at ${paneId}; inspect Herdr before retrying. No existing pane was closed. ${error instanceof Error ? error.message : String(error)}`,
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
