import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { writeFileSync } from "node:fs";
import { Effect } from "effect";
import { check, until, type Stack } from "./stack.ts";

/** What earlier flows made that later ones read again, so a restart can prove it lasted. */
export interface RunState {
  project?: { id: string; workspace: string };
  drop?: { itemId: string; file: string };
}

export interface Flow {
  readonly name: string;
  /** What the owner would notice if this broke. */
  readonly proves: string;
  readonly run: (stack: Stack, state: RunState) => Effect.Effect<unknown, unknown>;
}

const feedItems = (stack: Stack, project?: string) =>
  stack
    .cliJson("feed", ...(project ? ["--project", project] : []), "--json")
    .pipe(Effect.map((page) => (page.items ?? []) as Array<Record<string, any>>));

export const flows: readonly Flow[] = [
  {
    name: "boot",
    proves: "Clankie starts from an empty home with his own private Herdr fleet and answers",
    run: (stack) =>
      Effect.gen(function* () {
        // Its own free ports, never the live service's or relay's.
        const ports = [stack.env.PORT, stack.env.CLANKIE_RELAY_PORT, stack.env.CLANKIE_DEVICE_PORT];
        yield* check(
          new Set(ports).size === 3 && !ports.some((port) => port === "4310" || port === "4321"),
          "the scratch home has its own ports, apart from the live ones",
          ports,
        );
        // His own bundled Herdr, under the scratch home's state: never the owner's sessions.
        const herdr = yield* stack.cliJson("herdr", "create");
        yield* check(herdr.herdr?.runtime === "bundled", "herdr create selects his own fleet", herdr);
        const health = yield* stack.startService;
        yield* check(health.ok === true && health.service === "clankie", "health is ok", health);
        yield* check(
          (health.credentialStoreHealth as { state?: string } | undefined)?.state === "ready",
          "the credential broker is ready",
          health.credentialStoreHealth,
        );
        const listening = yield* until("the service logs that it is listening", async () =>
          stack.serviceLog().find((line) => line.msg === "clankie listening"),
        );
        yield* Effect.logInfo("listening").pipe(Effect.annotateLogs({ port: listening.port }));
        const fleet = yield* until(
          "his Herdr fleet is connected",
          () =>
            Effect.runPromise(stack.cliJson("herdr", "status", "--json")).then((status) =>
              status.active?.runtime === "bundled" &&
              String(status.active?.socketPath ?? "").startsWith(stack.directory) &&
              (status.machines as Array<{ sessions: Array<{ state: string }> }>)?.some((machine) =>
                machine.sessions.some((session) => session.state === "connected"),
              )
                ? status
                : undefined,
            ),
          { timeoutMs: 60_000, intervalMs: 1_000 },
        );
        yield* Effect.logDebug("herdr").pipe(Effect.annotateLogs({ active: fleet.active }));
      }),
  },
  {
    name: "authority",
    proves: "owner-only routes refuse anyone without the owner's credential",
    run: (stack) =>
      Effect.gen(function* () {
        for (const bearer of [undefined, "not-the-owner"]) {
          const response = yield* stack.http("/v1/pairing/offer", {
            method: "POST",
            headers: bearer ? { authorization: `Bearer ${bearer}` } : {},
          });
          yield* check(
            response.status === 401,
            `pairing offer refuses ${bearer ? "a wrong bearer" : "no bearer"}`,
            {
              status: response.status,
            },
          );
        }
        const projects = yield* stack.http("/v1/operator/projects");
        yield* check([401, 404].includes(projects.status), "project settings refuse no bearer", {
          status: projects.status,
        });
        // The CLI holds the owner's credential from the broker and is let in.
        const status = yield* stack.cliJson("status");
        yield* check(
          status.operatorCredential?.present === true,
          "the CLI finds the owner's credential",
          status.operatorCredential,
        );
      }),
  },
  {
    name: "status",
    proves: "`clankie status` and `clankie seat show` read the live service",
    run: (stack) =>
      Effect.gen(function* () {
        const status = yield* stack.cliJson("status");
        yield* check(status.ok === true && status.status === "ready", "status is ready", {
          ok: status.ok,
          status: status.status,
        });
        const clankie = (status.services as Array<{ id: string; state: string }>).find(
          (s) => s.id === "clankie",
        );
        yield* check(clankie?.state === "healthy", "status shows Clankie healthy", clankie);
        const seat = yield* stack.cliJson("seat", "show");
        yield* check(
          typeof seat.seat === "string" && typeof seat.revision === "string",
          "seat show names a seat",
          seat,
        );
      }),
  },
  {
    name: "relay",
    proves:
      "the app relay the phone reaches starts beside the service, and a phone pairs from `clankie pair` and reads the owner's settings through it",
    run: (stack) =>
      Effect.gen(function* () {
        const health = yield* stack.startRelay;
        yield* check(health !== undefined, "the relay answers /health", health);
        const status = yield* until("status sees the relay", () =>
          Effect.runPromise(stack.cliJson("status")).then((value) =>
            (value.services as Array<{ id: string; state: string }>).find(
              (s) => s.id === "relay" && s.state === "healthy",
            ),
          ),
        );
        yield* Effect.logInfo("relay healthy").pipe(Effect.annotateLogs({ relay: status }));

        // The phone's side of pairing: the owner mints an offer with the CLI, and
        // the app redeems it with no credential of its own.
        const offer = yield* stack.cliJson("pair", "--json");
        yield* check(offer.ok === true && typeof offer.code === "string", "`clankie pair` mints an offer", {
          ok: offer.ok,
        });
        const post = (path: string, body: unknown) =>
          stack.http(path, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(body),
          });
        const redeemed = yield* post("/v1/pairing/redeem", {
          code: offer.code,
          device: { name: "Real run phone", platform: "ios" },
        });
        yield* check(redeemed.status === 200, "the app redeems the code", { status: redeemed.status });
        const pending = (yield* Effect.promise(() => redeemed.json())) as {
          completionToken?: string;
          offeredGrants?: unknown;
          deviceToken?: unknown;
        };
        yield* check(
          pending.deviceToken === undefined && !JSON.stringify(pending).includes(offer.code),
          "redeeming hands out no device token and never echoes the code",
        );
        const completed = yield* post("/v1/pairing/complete", {
          completionToken: pending.completionToken,
          acceptedGrants: pending.offeredGrants,
        });
        yield* check(completed.status === 200, "the app completes pairing", { status: completed.status });
        const paired = (yield* Effect.promise(() => completed.json())) as {
          relayUrl?: string;
          deviceToken?: string;
        };
        yield* check(paired.relayUrl === stack.relayUrl, "pairing points the app at this relay", {
          relayUrl: paired.relayUrl,
        });
        const settings = yield* Effect.tryPromise(() =>
          fetch(`${stack.relayUrl}/v1/operator/host-settings`, {
            headers: { authorization: `Bearer ${paired.deviceToken}` },
            signal: AbortSignal.timeout(10_000),
          }),
        );
        yield* check(
          settings.status === 200,
          "the paired phone reads the owner's settings through the relay",
          {
            status: settings.status,
          },
        );
        const reused = yield* post("/v1/pairing/redeem", {
          code: offer.code,
          device: { name: "Second phone", platform: "ios" },
        });
        yield* check(reused.status !== 200, "a used code pairs nothing more", { status: reused.status });
      }),
  },
  {
    name: "project",
    proves: "a project is created on a real repository with a file tracker",
    run: (stack, state) =>
      Effect.gen(function* () {
        // A real repository with a local bare origin, as hires check origin/main is fresh.
        const workspace = join(stack.directory, "workspaces", "garden");
        const origin = join(stack.directory, "workspaces", "garden.git");
        mkdirSync(workspace, { recursive: true });
        const git = (...args: string[]) => execFileSync("git", args, { cwd: workspace, stdio: "pipe" });
        execFileSync("git", ["init", "-q", "--bare", "-b", "main", origin]);
        git("init", "-q", "-b", "main");
        git(
          "-c",
          "user.name=Real run",
          "-c",
          "user.email=real-run@clankie.invalid",
          "commit",
          "-q",
          "--allow-empty",
          "-m",
          "init",
        );
        git("remote", "add", "origin", origin);
        git("push", "-q", "-u", "origin", "main");
        const before = yield* stack.cliJson("project", "list");
        const settingsFile = join(stack.directory, "garden-project.json");
        writeFileSync(
          settingsFile,
          JSON.stringify({
            name: "Garden",
            workspacePath: workspace,
            trackerRef: { workspaceId: "primary", path: ".clankie/tracking.json" },
            trackerSetup: { backend: "markdown", directory: ".clankie/work" },
          }),
        );
        yield* stack.cliJson(
          "project",
          "create",
          "garden",
          "--settings",
          settingsFile,
          "--revision",
          before.revision,
        );
        const after = yield* stack.cliJson("project", "list");
        const garden = (after.settings.projects as Array<{ id: string }>).find(
          (project) => project.id === "garden",
        );
        yield* check(garden !== undefined, "project list shows the new project", after.settings.projects);
        yield* check(
          existsSync(join(workspace, ".clankie/tracking.json")),
          "the tracker convention is written in the repo",
        );
        state.project = { id: "garden", workspace };
      }),
  },
  {
    name: "feed",
    proves: "a drop and a quick check reach the owner's feed, and answering the check clears it",
    run: (stack, state) =>
      Effect.gen(function* () {
        const project = state.project;
        yield* check(project !== undefined, "a project exists from the project flow");
        const filed = yield* stack.cliJson(
          "feed",
          "drop",
          "--project",
          project!.id,
          "--title",
          "Real run drop",
          "--body",
          "Filed by the real-app run.",
          "--json",
        );
        yield* check(filed.outcome === "filed", "the drop is filed", filed);
        const file = join(project!.workspace, filed.file as string);
        yield* check(existsSync(file), "the drop is a file in the project's repo", { file });
        state.drop = { itemId: filed.item.drop.itemId, file };
        const raised = yield* stack.cliJson(
          "feed",
          "check",
          "--project",
          project!.id,
          "--json",
          "Does the real run look right?",
        );
        yield* check(raised.outcome === "raised", "the check is raised", raised);
        const items = yield* feedItems(stack, project!.id);
        const drop = items.find((item) => item.kind === "drop" && item.drop?.itemId === state.drop!.itemId);
        const pending = items.find((item) => item.kind === "check" && item.id === raised.item.id);
        yield* check(
          drop?.drop?.source?.kind === "machine",
          "the feed shows the drop from this machine",
          drop,
        );
        yield* check(
          pending?.check?.question?.status === "pending",
          "the feed shows the check pending",
          pending,
        );
        const question = pending!.check.question;
        const works = (question.options as Array<{ optionId: string; label: string }>).find(
          (o) => o.label === "It works",
        );
        yield* stack.cliJson(
          "conversations",
          "answer",
          question.conversationId,
          question.requestId,
          "--incarnation",
          question.incarnationId,
          "--revision",
          String(pending!.check.revision),
          "--option",
          works!.optionId,
        );
        const cleared = yield* until("the answered check leaves the feed", () =>
          Effect.runPromise(feedItems(stack, project!.id)).then((now) =>
            now.some((item) => item.id === raised.item.id) ? undefined : now,
          ),
        );
        yield* check(
          cleared.some((item) => item.kind === "drop"),
          "the drop stays on the feed after the check is answered",
        );
      }),
  },
  {
    name: "autonomy",
    proves: "the autonomy dial changes and reads back",
    run: (stack) =>
      Effect.gen(function* () {
        const set = yield* stack.cliJson("autonomy", "low");
        yield* check(
          set.level === "low" && typeof set.confirmedAt === "string",
          "autonomy low is saved and confirmed",
          set,
        );
        const read = yield* stack.cliJson("autonomy", "status");
        yield* check(read.level === "low", "autonomy status reads low", { level: read.level });
      }),
  },
  {
    name: "routine",
    proves:
      "a check routine runs now through the fleet's heavy permits and records its result, and the owner adds, pauses, edits, resumes and removes routines through the CLI",
    run: (stack, state) =>
      Effect.gen(function* () {
        const added = yield* stack.cliJson(
          "routines",
          "add",
          "Real run check",
          "--when",
          "every day at 3:00",
          "--check",
          "--cwd",
          state.project?.workspace ?? stack.directory,
          "--json",
          "--",
          "git",
          "status",
          "--short",
        );
        const routine = (added.routines as Array<{ id: string; name: string }>).find(
          (r) => r.name === "Real run check",
        );
        yield* check(routine !== undefined, "the routine is listed", added);
        yield* stack.cli("routines", "run-now", routine!.id, "--json");
        const run = yield* until(
          "the routine's run finishes",
          () =>
            Effect.runPromise(stack.cliJson("routines", "history", routine!.id, "--json")).then((history) => {
              const runs = (history.runs ?? history.history ?? []) as Array<{ id: string; status: string }>;
              return runs.find((r) => r.status !== "running");
            }),
          { timeoutMs: 120_000, intervalMs: 1_000 },
        );
        yield* check(run.status === "succeeded", "the routine's run succeeded", run);
        // Its permit came from the service's own fleet registry, which in this scratch
        // home is the fixture's: the Mac's permit this real run holds covers it, so it
        // never queues behind other heavy work for a second one (#193).
        const leasesFile = join(stack.env.CLANKIE_TEST_FLEET_RESOURCES_DIRECTORY!, "leases.jsonl");
        const held = (existsSync(leasesFile) ? readFileSync(leasesFile, "utf8").trim().split("\n") : [])
          .filter(Boolean)
          .map((line) => JSON.parse(line) as { event: string; holderId?: string; exitCode?: number })
          .filter((lease) => lease.holderId === `routine:${run.id}`);
        yield* check(
          held.length === 2 &&
            held[0]!.event === "admitted" &&
            held[1]!.event === "released" &&
            held[1]!.exitCode === 0,
          "the routine's run held a heavy permit from the service's fleet for its whole run",
          held,
        );

        // The owner's routine controls, on a turn routine that never runs here.
        type Routine = { id: string; name: string; enabled: boolean; missed: string; nextRunAt?: string };
        type Schedule = { cron: string; timeZone: string };
        const one = (status: Record<string, any>) => status.routine as Routine & { schedule: Schedule };
        const turn = one(
          yield* stack.cliJson(
            "routines",
            "add",
            "Morning triage",
            "--when",
            "every weekday at 9:00",
            "--tz",
            "America/Chicago",
            "--turn",
            "Triage.",
            "--json",
          ),
        );
        yield* check(
          turn.schedule.cron === "0 9 * * 1-5" && turn.enabled && turn.missed === "catch_up",
          "a plain-language schedule becomes a weekday routine that catches up",
          turn,
        );
        const paused = one(yield* stack.cliJson("routines", "pause", turn.id, "--json"));
        yield* check(!paused.enabled, "pause stops the routine", paused);
        const edited = one(
          yield* stack.cliJson(
            "routines",
            "edit",
            turn.id,
            "--when",
            "every monday at 8am",
            "--missed",
            "skip",
            "--json",
          ),
        );
        yield* check(
          edited.schedule.cron === "0 8 * * 1" &&
            edited.schedule.timeZone === "America/Chicago" &&
            edited.missed === "skip",
          "an edit changes the schedule and keeps its time zone",
          edited,
        );
        const resumed = one(yield* stack.cliJson("routines", "resume", turn.id, "--json"));
        yield* check(
          resumed.enabled && Date.parse(resumed.nextRunAt ?? "") > Date.now(),
          "resume schedules the next run ahead",
          resumed,
        );
        const refused = yield* stack.cli(
          "routines",
          "add",
          "Bad",
          "--when",
          "whenever you like",
          "--turn",
          "x",
          "--json",
        );
        yield* check(
          refused.code !== 0 && /Schedule not understood/u.test(refused.stdout + refused.stderr),
          "a schedule it cannot read is refused by name",
          { exit: refused.code, stdout: refused.stdout, stderr: refused.stderr },
        );
        const anonymous = yield* stack.http("/v1/captain/routines");
        yield* check(anonymous.status === 401, "routines need the owner's credential", anonymous.status);
        const removed = yield* stack.cliJson("routines", "remove", turn.id, "--json");
        yield* check(
          !(removed.routines as Routine[]).some((r) => r.id === turn.id),
          "remove deletes the routine",
          removed,
        );
      }),
  },
  {
    name: "hire",
    proves:
      "a hire runs through admission against his real Herdr fleet and, with no signed-in harness, is refused by name before any pane opens",
    run: (stack, state) =>
      Effect.gen(function* () {
        const added = yield* stack.cliJson(
          "routines",
          "add",
          "Real run hire",
          "--when",
          "every day at 3:00",
          "--hire",
          JSON.stringify({
            title: "Ada",
            role: "builder",
            harness: "claude",
            workingDirectory: state.project?.workspace,
            effort: "low",
            effortReason: "The real run only proves admission.",
          }),
          "--brief",
          "Say hello and stop.",
          "--json",
        );
        const routine = added.routine as { id: string };
        yield* stack.cli("routines", "run-now", routine.id, "--json");
        const run = yield* until(
          "the hire's run finishes",
          () =>
            Effect.runPromise(stack.cliJson("routines", "history", routine.id, "--json")).then((history) =>
              (history.runs as Array<{ status: string; detail?: string }>).find(
                (r) => r.status !== "running",
              ),
            ),
          { timeoutMs: 120_000, intervalMs: 1_000 },
        );
        // The scratch home has no Claude sign-in, so admission must name the harness
        // as unavailable and say how to fix it, rather than open a pane that stalls.
        yield* check(
          run.status === "failed",
          "the hire does not claim success without a signed-in harness",
          run,
        );
        yield* check(
          /harness_unavailable/u.test(run.detail ?? ""),
          "admission names the harness as unavailable",
          run,
        );
        const roster = yield* stack.cliJson("fleet", "roster");
        yield* check(
          roster.complete === true && roster.counts?.total === 0,
          "no worker pane was left behind",
          roster.counts,
        );
      }),
  },
  {
    name: "restart",
    proves: "what the owner set survives a service restart",
    run: (stack, state) =>
      Effect.gen(function* () {
        yield* stack.stopService;
        yield* stack.startService;
        const projects = yield* stack.cliJson("project", "list");
        yield* check(
          (projects.settings.projects as Array<{ id: string }>).some(
            (project) => project.id === state.project?.id,
          ),
          "the project is still there",
        );
        const items = yield* feedItems(stack, state.project?.id);
        yield* check(
          items.some((item) => item.kind === "drop" && item.drop?.itemId === state.drop?.itemId),
          "the drop is still on the feed",
        );
        const autonomy = yield* stack.cliJson("autonomy", "status");
        yield* check(autonomy.level === "low", "autonomy is still low", { level: autonomy.level });
        // A restart must not file the drop a second time.
        const issues = readdirSync(join(state.project!.workspace, ".clankie/work")).filter((file) =>
          file.endsWith(".md"),
        );
        yield* check(issues.length === 1, "the repo still holds the one drop, filed once", issues);
      }),
  },
];
