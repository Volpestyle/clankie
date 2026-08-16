import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface HerdrRosterAgent {
  readonly paneId: string;
  readonly agent: string;
  readonly status: "working" | "idle" | "blocked" | "unknown";
  readonly title: string;
}

export interface HerdrRosterSnapshot {
  readonly agents: readonly HerdrRosterAgent[];
  readonly error?: string;
}

export type HerdrRosterRunner = (command: string, args: readonly string[]) => Promise<{ stdout: string }>;

export interface HerdrRosterOptions {
  readonly env?: NodeJS.ProcessEnv;
  readonly runCommand?: HerdrRosterRunner;
  readonly pollIntervalMs?: number;
}

const POLL_INTERVAL_MS = 5_000;
const AGENT_STATUSES = new Set(["working", "idle", "blocked"]);

function defaultRunner(command: string, args: readonly string[]): Promise<{ stdout: string }> {
  return execFileAsync(command, [...args], { maxBuffer: 1024 * 1024 }).then(({ stdout }) => ({
    stdout: String(stdout),
  }));
}

/**
 * Sibling agents running in Herdr panes.
 *
 * Herdr-hosted agent sessions are invisible to the clankie service, so a
 * roster built only from service state says "nobody is working" while the
 * workspace is full of them. Herdr already tracks pane agent lifecycle — this
 * reads `herdr pane list` as a second, explicitly observed source so an empty
 * roster means "no one is working", never "no visibility". Inert outside
 * `HERDR_ENV=1`.
 */
export class HerdrRoster {
  public readonly active: boolean;
  private readonly ownPaneId: string | undefined;
  private readonly workspaceId: string | undefined;
  private readonly runCommand: HerdrRosterRunner;
  private readonly pollIntervalMs: number;
  private agents: readonly HerdrRosterAgent[] = [];
  private error: string | undefined;
  private timer: ReturnType<typeof setInterval> | undefined;

  public constructor(options: HerdrRosterOptions = {}) {
    const env = options.env ?? process.env;
    this.active = env.HERDR_ENV === "1";
    this.ownPaneId = env.HERDR_PANE_ID?.trim() || undefined;
    this.workspaceId = env.HERDR_WORKSPACE_ID?.trim() || undefined;
    this.runCommand = options.runCommand ?? defaultRunner;
    this.pollIntervalMs = options.pollIntervalMs ?? POLL_INTERVAL_MS;
  }

  public snapshot(): HerdrRosterSnapshot {
    return { agents: this.agents, ...(this.error === undefined ? {} : { error: this.error }) };
  }

  public start(onChange: () => void): void {
    if (!this.active || this.timer !== undefined) return;
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
    const before = JSON.stringify([this.agents, this.error]);
    try {
      const args =
        this.workspaceId === undefined ? ["pane", "list"] : ["pane", "list", "--workspace", this.workspaceId];
      const { stdout } = await this.runCommand("herdr", args);
      this.agents = this.parse(stdout);
      this.error = undefined;
    } catch (caught) {
      // A visible failure beats a silently empty roster — that silence is the
      // bug this class exists to fix.
      this.agents = [];
      this.error = caught instanceof Error ? caught.message : String(caught);
    }
    return JSON.stringify([this.agents, this.error]) !== before;
  }

  private parse(stdout: string): HerdrRosterAgent[] {
    const parsed = JSON.parse(stdout) as { result?: { panes?: unknown } };
    const panes = Array.isArray(parsed.result?.panes) ? parsed.result.panes : [];
    const agents: HerdrRosterAgent[] = [];
    for (const value of panes) {
      if (value === null || typeof value !== "object") continue;
      const pane = value as Record<string, unknown>;
      const paneId = typeof pane.pane_id === "string" ? pane.pane_id : undefined;
      const agent = typeof pane.agent === "string" ? pane.agent : undefined;
      if (paneId === undefined || agent === undefined || paneId === this.ownPaneId) continue;
      // `--workspace` already scopes the query, but the response is untrusted:
      // a pane that cannot prove it belongs to this workspace never leaks in.
      if (this.workspaceId !== undefined && pane.workspace_id !== this.workspaceId) continue;
      const status = typeof pane.agent_status === "string" ? pane.agent_status : "unknown";
      // Herdr's `done` is a finished agent, not an active worker — excluded,
      // never mislabeled unknown. Unknown stays for genuinely novel statuses.
      if (status === "done") continue;
      agents.push({
        paneId,
        agent,
        status: AGENT_STATUSES.has(status) ? (status as HerdrRosterAgent["status"]) : "unknown",
        title: typeof pane.terminal_title_stripped === "string" ? pane.terminal_title_stripped : "",
      });
    }
    return agents.sort((left, right) => left.paneId.localeCompare(right.paneId));
  }
}
