import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname } from "node:path";
import { Hono } from "hono";
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

export interface SetupSurveyDependencies {
  /** Where the one survey is kept, so a restart or a closed app does not lose it. */
  readonly path: string;
  readonly settings: {
    load(): Promise<ClankieSettings>;
    update(mutate: (current: ClankieSettings) => ClankieSettings): Promise<ClankieSettings>;
  };
  readonly serve: (request: OperatorConversationServiceRequest) => Promise<OperatorConversationServiceResult>;
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

const words = (error: unknown) => (error instanceof Error ? error.message : String(error)).slice(0, 600);

export function createSetupSurveyService(deps: SetupSurveyDependencies): SetupSurveyService {
  const now = () => (deps.now?.() ?? new Date()).toISOString();
  let queue: Promise<unknown> = Promise.resolve();
  const serial = <T>(work: () => Promise<T>): Promise<T> => {
    const result = queue.then(work, work);
    queue = result.catch(() => undefined);
    return result;
  };
  async function read(): Promise<SetupSurvey | undefined> {
    try {
      const parsed = SetupSurveySchema.safeParse(JSON.parse(await readFile(deps.path, "utf8")));
      return parsed.success ? parsed.data : undefined;
    } catch {
      return undefined;
    }
  }
  async function write(survey: SetupSurvey): Promise<SetupSurvey> {
    await mkdir(dirname(deps.path), { recursive: true, mode: 0o700 });
    const temporary = `${deps.path}.${randomUUID()}.tmp`;
    await writeFile(temporary, `${JSON.stringify(survey, null, 2)}\n`, { mode: 0o600 });
    await rename(temporary, deps.path);
    return survey;
  }
  const snapshot = (survey: SetupSurvey | undefined): SetupSurveySnapshot => ({
    schemaVersion: 1,
    ...(survey === undefined ? {} : { survey }),
  });
  /** Watch goes off only for the survey, and comes back when it ends (ADR 0317). */
  async function setWatch(watch: boolean): Promise<void> {
    await deps.settings.update((current) => {
      const { watch: _watch, ...autonomy } = current.autonomy;
      return { ...current, autonomy: { ...autonomy, ...(watch ? { watch: true as const } : {}) } };
    });
  }
  async function closeAgent(survey: SetupSurvey): Promise<void> {
    if (survey.seatId === undefined) return;
    try {
      await deps.serve({ op: "close_seat", schemaVersion: 1, seatId: survey.seatId });
    } catch {
      /* The owner can still close its pane in Herdr; the survey ends either way. */
    }
  }
  async function end(
    survey: SetupSurvey,
    status: "applied" | "cancelled" | "failed",
    extra: Partial<SetupSurvey> = {},
  ): Promise<SetupSurvey> {
    await closeAgent(survey);
    const ended = await write({ ...survey, ...extra, status, endedAt: now() });
    // Watch comes back only after the agent closes: closing refuses while Watch is on.
    if (extra.restoresWatch ?? survey.restoresWatch) await setWatch(true);
    return ended;
  }
  /** Reads the agent's reports for a proposal; the survey moves to proposed once one parses. */
  async function refresh(survey: SetupSurvey): Promise<SetupSurvey> {
    if (survey.status !== "surveying" || survey.seatId === undefined) return survey;
    const answer = await deps.serve({
      op: "worker_reports",
      schemaVersion: 1,
      conversationId: LEAD,
      limit: 100,
    });
    if (answer.op !== "worker_reports") return survey;
    const reports = answer.page.items.filter((item) => item.seatId === survey.seatId);
    for (const report of reports.reverse()) {
      const proposal = proposalFromReport(report.text);
      if (proposal) return write({ ...survey, status: "proposed", proposal });
    }
    return survey;
  }
  async function applyLine(line: SetupSurveyLine, survey: SetupSurvey): Promise<SetupSurveyLineResult> {
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
        await deps.settings.update((current) => {
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
          if (restoresWatch) await setWatch(false);
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
          return snapshot(survey);
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
        return snapshot(await end(survey, "applied", { results, restoresWatch: working.restoresWatch }));
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
