import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname } from "node:path";
import { Hono } from "hono";
import { z } from "zod";
import { bodyLimit } from "hono/body-limit";
import {
  ApplySetupSurveySchema,
  CancelSetupSurveySchema,
  FleetAutonomySchema,
  SETUP_SURVEY_APPLY_PATH,
  SETUP_SURVEY_CANCEL_PATH,
  SETUP_SURVEY_PATH,
  SetupSurveyProposalSchema,
  SetupSurveySchema,
  StartSetupSurveySchema,
  autonomyLevelFleet,
  type OperatorConnectionCommand,
  type OperatorConversationServiceRequest,
  type OperatorConversationServiceResult,
  type SetupSurvey,
  type SetupSurveyLine,
  type SetupSurveyLineResult,
  type SetupSurveyProposal,
  type SetupSurveySnapshot,
} from "@clankie/protocol";
import type { ClankieSettings } from "@clankie/settings";

/** Clankie's own thread leads the setup agent, as it leads a connected app's start_agent. */
const LEAD = "global-default";
const ACTIVE = new Set<SetupSurvey["status"]>(["surveying", "proposed"]);

/**
 * The survey as Clankie keeps it: the agent's pane stays with it from the hire
 * on, so its report is still found after the pane closes. Readers never see it.
 */
/**
 * What only the service keeps: the agent's pane, so its report outlives the pane,
 * and the owner's autonomy as the survey left it, so Watch comes back only if the
 * owner has not chosen another level meanwhile.
 */
const KeptSurveySchema = SetupSurveySchema.extend({
  paneId: z.string().min(1).max(256).optional(),
  held: z.string().max(16_384).optional(),
});
type KeptSurvey = z.infer<typeof KeptSurveySchema>;

/** The owner's autonomy apart from Watch, with keys in one order so two reads compare. */
const heldAutonomy = (settings: ClankieSettings): string => {
  const { watch: _watch, ...autonomy } = settings.autonomy;
  return JSON.stringify(autonomy, (_key, value: unknown) =>
    value !== null && typeof value === "object" && !Array.isArray(value)
      ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
      : value,
  );
};

export interface SetupSurveyDependencies {
  /** Where the one survey is kept, so a restart or a closed app does not lose it. */
  readonly path: string;
  readonly settings: {
    load(): Promise<ClankieSettings>;
    update(mutate: (current: ClankieSettings) => ClankieSettings): Promise<ClankieSettings>;
  };
  readonly serve: (request: OperatorConversationServiceRequest) => Promise<OperatorConversationServiceResult>;
  /**
   * The agent's reports to the lead thread since it started, read or not: the
   * thread's lead may read one before the owner looks.
   */
  readonly reports: (input: {
    readonly conversationId: string;
    readonly seatId: string;
    readonly paneId?: string;
    readonly since: string;
  }) => Promise<{ readonly paneId?: string; readonly reports: readonly { readonly text: string }[] }>;
  /** The connection API setup and Settings use; it returns the inventory after the change. */
  readonly connections: (command: OperatorConnectionCommand) => Promise<unknown>;
  /** What the agent starts from: the machines, sessions and projects Clankie already knows. */
  readonly facts: () => Promise<unknown>;
  readonly home?: string;
  readonly now?: () => Date;
}

export interface SetupSurveyService {
  snapshot(): Promise<SetupSurveySnapshot>;
  start(account?: string): Promise<SetupSurveySnapshot>;
  apply(surveyId: string, lineIds: readonly string[]): Promise<SetupSurveySnapshot>;
  cancel(surveyId: string): Promise<SetupSurveySnapshot>;
}

class SetupSurveyConflict extends Error {}

/** The brief, kept to what the agent needs: what to look at, what not to touch, and the one report shape. */
function setupSurveyBrief(facts: unknown): string {
  return [
    "You are Clankie's setup agent. The owner just installed Clankie and asked you to look around his setup once and propose how to finish setting it up.",
    "",
    "You are read-only. You can read and search files, and run exactly `git status --short`, `git log --oneline -20`, `git remote -v` and `tailscale status --json`, as written. Read a repository's `.git/config` for its remotes. Every other tool and command is refused. Do not try to change anything; Clankie applies only the lines the owner approves.",
    "",
    "Look at:",
    "- The machines and Herdr sessions below, and which ones Clankie does not have yet.",
    "- The repositories under the owner's usual code folders (for example ~/dev, ~/code, ~/src): their remotes, and the tracker each one uses (GitHub issues, Linear, or none), from its guide files (AGENTS.md, CLAUDE.md, README) and remotes.",
    "- Which coding agents and accounts he already uses.",
    "",
    "Then call message_clankie once with your proposal: a short plain sentence or two, then one fenced ```json block holding exactly this shape, and nothing else in the block:",
    "",
    "```json",
    JSON.stringify(
      {
        schemaVersion: 1,
        summary: "What you found, in a sentence or two the owner reads.",
        findings: ["One fact per line, in plain words."],
        lines: [
          {
            kind: "add_machine",
            id: "add-desktop",
            why: "…",
            machine: "desktop",
            ssh: "user@desktop",
            shell: "posix",
          },
          {
            kind: "connect_session",
            id: "connect-desktop",
            why: "…",
            machine: "desktop",
            session: "default",
          },
          {
            kind: "machine_access",
            id: "desktop-workers",
            why: "…",
            machine: "desktop",
            accessLevel: "workers",
          },
          { kind: "autonomy", id: "autonomy", why: "…", level: "off" },
          { kind: "pair_phone", id: "phone", why: "…" },
          { kind: "connect_lead", id: "lead-claude", why: "…", lead: "Claude Code" },
          { kind: "owner_step", id: "install-herdr", why: "…", step: "Install Herdr on the desktop." },
        ],
      },
      null,
      2,
    ),
    "```",
    "",
    "Rules for the proposal:",
    "- Propose only what your reading supports, and say in `why` what you saw. Leave out a line when you are not sure.",
    "- Line ids are short lowercase words with hyphens, unique in the proposal.",
    "- `ssh` is a host or user@host that already works for the owner; `shell` is posix or powershell.",
    "- `accessLevel` is portal, workers, shell or screen. `level` is watch, off, low, high or full.",
    "- Write every sentence for the owner, in plain words, without internal names.",
    "- After you send it, stop. Clankie closes this agent when the owner has chosen.",
    "",
    "What Clankie already knows:",
    "```json",
    JSON.stringify(facts, null, 2).slice(0, 16_000),
    "```",
  ].join("\n");
}

/** The last fenced JSON block in a report that parses as a proposal, if any. */
function proposalFromReport(text: string): SetupSurveyProposal | undefined {
  const blocks = [...text.matchAll(/```(?:json)?\s*\n([\s\S]*?)```/gu)].map((match) => match[1]!);
  for (const block of blocks.reverse()) {
    try {
      const parsed = SetupSurveyProposalSchema.safeParse(JSON.parse(block));
      if (parsed.success) return parsed.data;
    } catch {
      /* Not JSON; an earlier block may be the proposal. */
    }
  }
  return undefined;
}

const UNLANDED_REASON =
  "Setup's read-only agent only looked around; the files in its folder are the owner's own.";

const words = (error: unknown) => (error instanceof Error ? error.message : String(error)).slice(0, 600);

export function createSetupSurveyService(deps: SetupSurveyDependencies): SetupSurveyService {
  const now = () => (deps.now?.() ?? new Date()).toISOString();
  let queue: Promise<unknown> = Promise.resolve();
  const serial = <T>(work: () => Promise<T>): Promise<T> => {
    const result = queue.then(work, work);
    queue = result.catch(() => undefined);
    return result;
  };
  async function read(): Promise<KeptSurvey | undefined> {
    try {
      const parsed = KeptSurveySchema.safeParse(JSON.parse(await readFile(deps.path, "utf8")));
      return parsed.success ? parsed.data : undefined;
    } catch {
      return undefined;
    }
  }
  async function write(survey: KeptSurvey): Promise<KeptSurvey> {
    await mkdir(dirname(deps.path), { recursive: true, mode: 0o700 });
    const temporary = `${deps.path}.${randomUUID()}.tmp`;
    await writeFile(temporary, `${JSON.stringify(survey, null, 2)}\n`, { mode: 0o600 });
    await rename(temporary, deps.path);
    return survey;
  }
  const snapshot = (kept: KeptSurvey | undefined): SetupSurveySnapshot => {
    if (kept === undefined) return { schemaVersion: 1 };
    const { paneId: _paneId, held: _held, ...survey } = kept;
    return { schemaVersion: 1, survey };
  };
  /** Watch goes off only for the survey, and comes back when it ends (ADR 0317). */
  async function setWatch(watch: boolean, held?: string): Promise<ClankieSettings> {
    return deps.settings.update((current) => {
      // A level the owner chose while the agent looked around stands (ADR 0317).
      if (watch && held !== undefined && heldAutonomy(current) !== held) return current;
      const { watch: _watch, ...autonomy } = current.autonomy;
      return { ...current, autonomy: { ...autonomy, ...(watch ? { watch: true as const } : {}) } };
    });
  }
  /**
   * Closes the agent. Its folder may be the owner's home tracked in Git, whose
   * uncommitted files are his own, not the agent's work, so the close says so
   * instead of holding on them. A close the service still refuses leaves the
   * survey running, so stopping it again retries (ADR 0317).
   */
  async function closeAgent(survey: SetupSurvey, mustClose: boolean): Promise<void> {
    if (survey.seatId === undefined) return;
    let answer: OperatorConversationServiceResult;
    try {
      answer = await deps.serve({
        op: "close_seat",
        schemaVersion: 1,
        seatId: survey.seatId,
        unlandedReason: UNLANDED_REASON,
      });
    } catch {
      /* Watch chosen meanwhile refuses every close; the owner can still close its pane in Herdr. */
      return;
    }
    if (mustClose && answer.op === "close_seat" && !answer.closed && answer.refusal !== undefined)
      throw new SetupSurveyConflict(
        "Clankie couldn’t close the setup agent. Close its pane in Herdr, then try again.",
      );
  }
  async function end(
    survey: KeptSurvey,
    status: "applied" | "cancelled" | "failed",
    extra: Partial<KeptSurvey> = {},
    closed = false,
  ): Promise<KeptSurvey> {
    if (!closed) await closeAgent(survey, status !== "failed");
    const ended = await write({ ...survey, ...extra, status, endedAt: now() });
    // Watch comes back only after the agent closes: closing refuses while Watch is on.
    if (ended.restoresWatch) await setWatch(true, ended.held);
    return ended;
  }
  /** Reads the agent's reports for a proposal; the survey moves to proposed once one parses. */
  async function refresh(survey: KeptSurvey): Promise<KeptSurvey> {
    if (survey.status !== "surveying" || survey.seatId === undefined) return survey;
    const answer = await deps.reports({
      conversationId: LEAD,
      seatId: survey.seatId,
      ...(survey.paneId === undefined ? {} : { paneId: survey.paneId }),
      since: survey.startedAt,
    });
    const kept = survey.paneId ?? answer.paneId;
    const withPane = kept === undefined ? survey : { ...survey, paneId: kept };
    for (const report of [...answer.reports].reverse()) {
      const proposal = proposalFromReport(report.text);
      if (proposal) return write({ ...withPane, status: "proposed", proposal });
    }
    return withPane === survey ? survey : write(withPane);
  }
  async function applyLine(line: SetupSurveyLine, survey: KeptSurvey): Promise<SetupSurveyLineResult> {
    switch (line.kind) {
      case "add_machine":
        await deps.connections({ action: "add_machine", id: line.machine, ssh: line.ssh, shell: line.shell });
        return { lineId: line.id, outcome: "applied" };
      case "connect_session":
        await deps.connections({
          action: "connect_runtime",
          id: `${line.machine}-${line.session}`.slice(0, 64).replace(/[^a-z0-9-]/gu, "-"),
          machine: line.machine,
          session: line.session,
        });
        return { lineId: line.id, outcome: "applied" };
      case "machine_access":
        await deps.connections({
          action: "set_machine_access",
          id: line.machine,
          accessLevel: line.accessLevel,
        });
        return { lineId: line.id, outcome: "applied" };
      case "autonomy":
        // The owner's own level wins over Watch coming back. Choosing Watch itself
        // applies Off's leaves now and turns Watch on once the agent has closed.
        survey.restoresWatch = line.level === "watch";
        const chosen = await deps.settings.update((current) => {
          const { watch: _watch, ...autonomy } = current.autonomy;
          const level = line.level === "watch" ? "off" : line.level;
          return {
            ...current,
            autonomy: {
              ...autonomy,
              confirmedAt: current.autonomy.confirmedAt ?? now(),
              fleet: FleetAutonomySchema.parse({ ...current.autonomy.fleet, ...autonomyLevelFleet(level) }),
            },
          };
        });
        survey.held = heldAutonomy(chosen);
        return { lineId: line.id, outcome: "applied" };
      case "pair_phone":
      case "connect_lead":
      case "owner_step":
        return { lineId: line.id, outcome: "yours" };
    }
  }
  return {
    snapshot: () =>
      serial(async () =>
        snapshot(
          await (async () => {
            const survey = await read();
            return survey === undefined ? undefined : refresh(survey);
          })(),
        ),
      ),
    start: (account) =>
      serial(async () => {
        const current = await read();
        if (current !== undefined && ACTIVE.has(current.status))
          throw new SetupSurveyConflict("A setup agent is already looking around");
        const settings = await deps.settings.load();
        const restoresWatch = settings.autonomy.watch === true;
        let survey = await write({
          id: randomUUID(),
          status: "surveying",
          startedAt: now(),
          harness: "claude",
          ...(account === undefined ? {} : { account }),
          restoresWatch,
        });
        try {
          // Watch refuses every hire (ADR 0308); it steps aside only for this one.
          if (restoresWatch) survey = await write({ ...survey, held: heldAutonomy(await setWatch(false)) });
          const brief = setupSurveyBrief(await deps.facts());
          const answer = await deps.serve({
            op: "spawn_seat",
            schemaVersion: 1,
            conversationId: LEAD,
            seat: {
              schemaVersion: 1,
              harness: "claude",
              ...(account === undefined ? {} : { account }),
              title: "setup",
              taskTitle: "Look around your setup",
              workingDirectory: deps.home ?? homedir(),
              hireKind: "worker",
              readOnly: true,
              effort: "medium",
              effortReason: "Setup's one read-only look around; medium reads and reports",
            },
            brief,
          });
          if (answer.op !== "spawn_seat") throw new Error("Clankie could not start the setup agent");
          if (answer.result.outcome !== "spawned")
            return snapshot(
              await end(survey, "failed", {
                detail: answer.result.detail ?? "Clankie could not start the setup agent.",
              }),
            );
          survey = await write({ ...survey, seatId: answer.result.seat.seatId });
          // Keep the agent's pane now, while it is surely open.
          return snapshot(await refresh(survey));
        } catch (error) {
          return snapshot(await end(survey, "failed", { detail: words(error) }));
        }
      }),
    apply: (surveyId, lineIds) =>
      serial(async () => {
        let survey = await read();
        if (survey === undefined || survey.id !== surveyId)
          throw new SetupSurveyConflict("That setup has ended");
        survey = await refresh(survey);
        if (survey.status !== "proposed" || survey.proposal === undefined)
          throw new SetupSurveyConflict("The setup agent has not proposed anything yet");
        const approved = new Set(lineIds);
        const known = new Set(survey.proposal.lines.map((line) => line.id));
        if ([...approved].some((id) => !known.has(id)))
          throw new SetupSurveyConflict("Approve only lines from this proposal");
        // The proposal is in hand: close the agent first, so a refused close changes nothing.
        await closeAgent(survey, true);
        const results: SetupSurveyLineResult[] = [];
        const working = { ...survey };
        for (const line of survey.proposal.lines) {
          if (!approved.has(line.id)) continue;
          try {
            results.push(await applyLine(line, working));
          } catch (error) {
            results.push({ lineId: line.id, outcome: "failed", detail: words(error) });
          }
        }
        return snapshot(
          await end(
            survey,
            "applied",
            {
              results,
              restoresWatch: working.restoresWatch,
              ...(working.held === undefined ? {} : { held: working.held }),
            },
            true,
          ),
        );
      }),
    cancel: (surveyId) =>
      serial(async () => {
        const survey = await read();
        if (survey === undefined || survey.id !== surveyId)
          throw new SetupSurveyConflict("That setup has ended");
        if (!ACTIVE.has(survey.status)) return snapshot(survey);
        return snapshot(await end(survey, "cancelled"));
      }),
  };
}

type Authorize = (request: Request) => Promise<true | "authentication_required" | "forbidden">;

export function createSetupSurveyRoutes(authorize: Authorize, survey: SetupSurveyService | undefined) {
  const app = new Hono();
  const refused = (authority: "authentication_required" | "forbidden") =>
    Response.json({ error: authority }, { status: authority === "forbidden" ? 403 : 401 });
  class InvalidRequest extends Error {}
  const run = async (
    request: Request,
    work: (service: SetupSurveyService) => Promise<SetupSurveySnapshot>,
  ) => {
    const authority = await authorize(request);
    if (authority !== true) return refused(authority);
    if (survey === undefined) return Response.json({ error: "setup_survey_unavailable" }, { status: 503 });
    try {
      return Response.json(await work(survey));
    } catch (error) {
      if (error instanceof InvalidRequest)
        return Response.json({ error: "invalid_request" }, { status: 400 });
      if (error instanceof SetupSurveyConflict)
        return Response.json({ error: "setup_survey_conflict", detail: error.message }, { status: 409 });
      return Response.json({ error: "setup_survey_failed", detail: words(error) }, { status: 500 });
    }
  };
  const body = async <T>(
    request: Request,
    schema: { safeParse(value: unknown): { data?: T } },
  ): Promise<T> => {
    let value: unknown;
    try {
      value = await request.json();
    } catch {
      throw new InvalidRequest();
    }
    const parsed = schema.safeParse(value).data;
    if (parsed === undefined) throw new InvalidRequest();
    return parsed;
  };
  app.get(SETUP_SURVEY_PATH, (context) => run(context.req.raw, (service) => service.snapshot()));
  app.post(SETUP_SURVEY_PATH, bodyLimit({ maxSize: 4096 }), (context) =>
    run(context.req.raw, async (service) =>
      service.start((await body(context.req.raw, StartSetupSurveySchema)).account),
    ),
  );
  app.post(SETUP_SURVEY_APPLY_PATH, bodyLimit({ maxSize: 8192 }), (context) =>
    run(context.req.raw, async (service) => {
      const input = await body(context.req.raw, ApplySetupSurveySchema);
      return service.apply(input.surveyId, input.lineIds);
    }),
  );
  app.post(SETUP_SURVEY_CANCEL_PATH, bodyLimit({ maxSize: 4096 }), (context) =>
    run(context.req.raw, async (service) =>
      service.cancel((await body(context.req.raw, CancelSetupSurveySchema)).surveyId),
    ),
  );
  return app;
}
