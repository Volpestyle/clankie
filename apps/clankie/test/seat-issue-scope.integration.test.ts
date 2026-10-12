import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { FileCredentialStore } from "@clankie/credential-broker";
import { SettingsStore } from "@clankie/settings";
import { ProjectsSettingsSchema } from "@clankie/protocol/projects";
import { createLocalTracker, writeConvention, type LinearImportSnapshot } from "@clankie/work-items";
import { createMcpHost } from "../src/mcp-host.ts";
import { createWorkItemsService } from "../src/work-items.ts";
import { trackerEvidence } from "./helpers/tracker-evidence.ts";
import { ProjectHires } from "../src/captain/project-hires.ts";
import {
  SeatIssueKeeper,
  prepareSeatIssueAttribution,
  type LiveSeatIssue,
} from "../src/captain/seat-issue-status.ts";

// Real disposable stores and production keeper/project routes. Native process proof
// below is an explicitly synthetic helper fixture, never a live pane retirement.
it("settles only the current verified hire scope across close, exit, collisions and authority refusals", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "local-vuh-8-")));
  const defaults = createLocalTracker({ directory: join(root, "default") });
  const snapshot = JSON.parse(
    await readFile(
      new URL("../../../packages/work-items/test/fixtures/linear-import/clankie-work.json", import.meta.url),
      "utf8",
    ),
  ) as LinearImportSnapshot;
  // Synthetic VUH-4 sentinel derived from a captured graph; no connected Linear.
  snapshot.issues[0]!.identifier = "VUH-4";
  await defaults.importLinear(snapshot, {});
  const defaultBefore = await readFile(join(root, "default", "tracker.json"), "utf8");
  const host = createMcpHost({
    credentials: new FileCredentialStore(join(root, "credentials.json")),
    settings: new SettingsStore(join(root, "settings.json")),
    localTracker: defaults,
    logger: { info() {}, warn() {} },
  });
  const evidence = trackerEvidence(root);
  const ledger = new ProjectHires(join(root, "hires.json"));
  const trace: Record<string, unknown> = {
    scope: "in-process real stores/routes/keeper; synthetic native attribution helper",
    noRealLinearWrites: true,
  };
  let now = Date.parse("2026-10-12T22:00:00Z");
  const keeper = new SeatIssueKeeper(host, join(root, "keeper.json"), {
    requireAttribution: true,
    now: () => now,
    exitGraceMs: 1,
  });
  const convention = {
    schemaVersion: 1 as const,
    backend: "builtin" as const,
    decidedBy: "owner" as const,
    decidedAt: "2026-10-12T00:00:00Z",
  };
  async function fixture(id: string) {
    const path = join(root, id);
    await mkdir(path);
    await writeConvention(path, convention);
    const directory = join(root, `${id}-store`);
    const store = createLocalTracker({
      directory,
      team: "VUH",
      project: id,
      validateEvidence: evidence.validateEvidence,
    });
    const projects = (await store.call("list_projects", {})) as { projects: { id: string }[] };
    const projectId = projects.projects[0]!.id;
    let issue: Record<string, unknown> = {};
    for (let index = 1; index <= 4; index++)
      issue = (await store.call("save_issue", {
        team: "VUH",
        project: projectId,
        title: `${id} item ${index}`,
      })) as Record<string, unknown>;
    await store.call("post_issue_event", { issueId: issue.id, type: "ack" });
    let settings = ProjectsSettingsSchema.parse({
      projects: [
        {
          id,
          name: id,
          workerCap: 20,
          workspaces: [{ id: "primary", machineId: "local", platform: "posix", path }],
          trackerRef: { workspaceId: "primary", path: ".clankie/tracking.json" },
          trackerProjectId: projectId,
        },
      ],
    });
    const service = createWorkItemsService({
      stateDirectory: join(root, `${id}-service`),
      globalTrackerDirectory: directory,
      builtInTracker: (assertIssueWrite) =>
        createLocalTracker({
          directory,
          validateEvidence: evidence.validateEvidence,
          ...(assertIssueWrite ? { assertIssueWrite } : {}),
        }),
      projects: async () => settings,
      projectsFence: async () => {
        const snapshot = JSON.stringify(settings);
        return {
          projects: settings,
          assertCurrent: () => {
            if (snapshot !== JSON.stringify(settings)) throw new Error("fixture saved settings changed");
          },
        };
      },
      localMachineId: "local",
    });
    let sequence = 0;
    const seat = async (
      label: string,
      key = "LOCAL-VUH-4",
      paneOverride?: string,
    ): Promise<LiveSeatIssue> => {
      const pane = paneOverride ?? `${id}-${sequence + 1}`;
      sequence++;
      const occupant = `fixture-${pane}`;
      const allocation = ledger.reserve(settings, id, {
        schemaVersion: 1,
        title: label,
        workingDirectory: join(path, `${pane}-${sequence}`),
        harness: "codex",
        deliverable: key,
      });
      ledger.launch(allocation.id, settings);
      ledger.pane(allocation.id, pane);
      const proof = {
        nativeOccupantId: occupant,
        fleet: "default",
        pane,
        binding: { socketPath: join(root, "fixture-only.sock") },
        processes: [{ pid: 22, startTime: "fixture" }],
        shell: { pid: 11, startTime: "fixture" },
      };
      ledger.observe(allocation.id, pane, occupant, proof);
      ledger.confirmed(allocation.id);
      expect(ledger.assignment("default", pane, proof).state).toBe("assigned");
      const native = { fleet: "default", pane, nativeOccupantId: occupant };
      const routes = {
        proof: async () => proof,
        watches: {
          projectHireAssignment: (fleet: string, paneId: string, current = proof) =>
            ledger.assignment(fleet, paneId, current),
          projectHireBookkeepingAttribution: (fleet: string, paneId: string, occupantId: string) =>
            ledger.bookkeepingAttribution(fleet, paneId, occupantId),
        },
        workItems: service,
        projects: async () => settings,
      };
      // Run the exact production capture helper with synthetic native observations.
      await expect(
        prepareSeatIssueAttribution({ ...native, nativeOccupantId: "stale-roster-occupant" }, routes),
      ).rejects.toThrow("changed occupant");
      await expect(
        prepareSeatIssueAttribution(native, {
          ...routes,
          proof: async () => ({ ...proof, nativeSessionPending: true as const }),
        }),
      ).rejects.toThrow("unavailable");
      const attribution = await prepareSeatIssueAttribution(native, routes);
      return { seatId: pane, title: label, keys: [key], attribution };
    };
    return {
      store,
      service,
      issue,
      seat,
      path,
      rebind: (trackerProjectId: string) => {
        settings.projects[0]!.trackerProjectId = trackerProjectId;
      },
      overlap: () => {
        settings.projects.push({ ...structuredClone(settings.projects[0]!), id: `${id}-overlap` });
      },
      revoke: () => {
        settings = ProjectsSettingsSchema.parse({ projects: [] });
      },
    };
  }
  try {
    const a = await fixture("a");
    const b = await fixture("b");
    const aSeat = await a.seat("Iris fixture");
    const bSeat = await b.seat("Other scope same display key");
    await keeper.observe([aSeat, bSeat]);
    const close = await keeper.closed({ seatId: aSeat.seatId, reason: "fixture retirement" });
    expect(close).toMatchObject({
      outcome: "updated",
      issue: "LOCAL-VUH-4",
      intended: "Paused",
      status: "Todo",
    });
    expect(await a.store.call("get_issue", { id: "LOCAL-VUH-4" })).toMatchObject({ status: "Todo" });
    expect(await b.store.call("get_issue", { id: "LOCAL-VUH-4" })).toMatchObject({ status: "In Progress" });
    expect(await a.store.call("list_comments", { issueId: a.issue.id })).toMatchObject({
      comments: [expect.objectContaining({ body: expect.stringContaining("Iris fixture left") })],
    });
    trace.retirement = close;
    // Only the matching scope resumes. A different tracker key must not consume A's pause.
    expect(await keeper.observe([bSeat])).toEqual([]);
    const resumed = await a.seat("A successor");
    expect(await keeper.observe([resumed, bSeat])).toMatchObject([
      { outcome: "updated", issue: "LOCAL-VUH-4", status: "In Progress" },
    ]);
    await keeper.observe([bSeat]);
    // Real ledger reconciliation expires the captured allocation, not its bookkeeping provenance.
    const entries = ledger.inventoryCandidates("default");
    ledger.reconcile("default", new Set([bSeat.seatId]), new Set(), entries);
    now += 2;
    const exit = await keeper.observe([bSeat]);
    expect(exit).toMatchObject([
      { outcome: "updated", issue: "LOCAL-VUH-4", intended: "Paused", status: "Todo" },
    ]);
    trace.observedExit = exit;
    expect(await b.store.call("get_issue", { id: "LOCAL-VUH-4" })).toMatchObject({ status: "In Progress" });

    const missing = { seatId: "missing", title: "Missing attribution", keys: ["LOCAL-VUH-4"] };
    expect(await keeper.observe([missing, bSeat])).toMatchObject([
      { outcome: "failed", detail: expect.stringContaining("attribution") },
    ]);
    expect(await keeper.closed({ seatId: missing.seatId, reason: "missing" })).toMatchObject({
      outcome: "skipped",
    });
    const ambiguous = await b.seat("Ambiguous label", "Compare LOCAL-VUH-4 and VUH-4");
    await keeper.observe([ambiguous, bSeat]);
    expect(await keeper.closed({ seatId: ambiguous.seatId, reason: "ambiguous" })).toMatchObject({
      outcome: "skipped",
    });
    const beforeRevoked = await readFile(join(root, "b-store", "tracker.json"), "utf8");
    b.revoke();
    const revoked = await keeper.closed({ seatId: bSeat.seatId, reason: "revoked" });
    expect(revoked).toMatchObject({ outcome: "failed", detail: expect.stringContaining("revoked") });
    expect(await readFile(join(root, "b-store", "tracker.json"), "utf8")).toBe(beforeRevoked);
    trace.refusals = {
      missing: "no attribution; no target",
      ambiguous: "multiple complete keys; no target",
      revoked,
    };

    const fenceSeat = await a.seat("Done is not owner verification", String(a.issue.id));
    await keeper.observe([fenceSeat]);
    const done = await keeper.closed({
      seatId: fenceSeat.seatId,
      reason: "fixture worker result",
      outcome: "done",
      evidence: "fixture evidence, not owner authority",
    });
    expect(done).toMatchObject({
      outcome: "failed",
      intended: "Done",
      detail: expect.stringContaining("owner_verification_required"),
    });
    expect(await a.store.call("get_issue", { id: a.issue.id })).toMatchObject({
      stage: "accepted",
      status: "In Progress",
    });
    trace.ownerFence = done;
    const wrongProject = (await a.store.call("save_project", { name: "unrelated", addTeams: ["VUH"] })) as {
      id: string;
    };
    const unrelated = (await a.store.call("save_issue", {
      team: "VUH",
      project: wrongProject.id,
      title: "same store outside hire scope",
    })) as { id: string };
    const outOfScope = await a.seat("Out of project", unrelated.id);
    await keeper.observe([outOfScope]);
    expect(await keeper.closed({ seatId: outOfScope.seatId, reason: "must refuse" })).toMatchObject({
      outcome: "failed",
    });
    expect(await a.store.call("get_issue", { id: unrelated.id })).toMatchObject({ status: "Todo" });
    expect(await a.store.call("list_comments", { issueId: unrelated.id })).toMatchObject({ comments: [] });

    // Human keys and UUIDs share successor ownership, pause restoration and daily counts.
    const byKey = await a.seat("Key predecessor");
    const byUuid = await a.seat("UUID successor", String(a.issue.id));
    await a.store.call("post_issue_event", { issueId: a.issue.id, type: "ack" });
    await keeper.observe([byKey, byUuid]);
    expect(await keeper.closed({ seatId: byKey.seatId, reason: "UUID successor continues" })).toMatchObject({
      intended: "In Progress",
      status: "In Progress",
    });
    expect((await keeper.dailyCheck(true)) ?? "").not.toContain("LOCAL-VUH-4:");
    expect(await keeper.closed({ seatId: byUuid.seatId, reason: "pause UUID assignment" })).toMatchObject({
      intended: "Paused",
      status: "Todo",
    });
    const keyReturns = await a.seat("Key alias returns");
    expect(await keeper.observe([keyReturns])).toMatchObject([{ outcome: "updated", status: "In Progress" }]);
    trace.canonicalAliases = "key/UUID successor, pause/resume and daily ownership passed";

    // Delivery gates use real evidence bytes and an independent fixture actor.
    const scope = await a.service.prepareSeatIssueTracker("a", async () => {});
    await scope.call(
      "post_issue_event",
      { issueId: a.issue.id, type: "result", stage: "landed" },
      "interactive",
    );
    await expect(
      scope.call(
        "post_issue_event",
        { issueId: a.issue.id, type: "result", stage: "delivered" },
        "interactive",
      ),
    ).rejects.toThrow("evidence_bundle_required");
    const reference = await evidence.record("LOCAL-VUH-4");
    const bundle = (await scope.call(
      "save_evidence_bundle",
      { issueId: a.issue.id, references: [reference], gaps: [] },
      "interactive",
    )) as { id: string };
    await expect(
      scope.call(
        "post_issue_event",
        { issueId: a.issue.id, type: "result", stage: "delivered" },
        "interactive",
      ),
    ).rejects.toThrow("bundle_check_required");
    await a.store.call(
      "post_bundle_check",
      { bundleId: bundle.id },
      { actor: { type: "agent-worker", id: "independent-fixture-checker", onBehalfOf: [] } },
    );
    await scope.call(
      "post_issue_event",
      { issueId: a.issue.id, type: "result", stage: "delivered" },
      "interactive",
    );
    const deliveredSeat = await a.seat("Delivered worker");
    await keeper.observe([deliveredSeat]);
    const deliveredDone = await keeper.closed({
      seatId: deliveredSeat.seatId,
      reason: "fixture delivered",
      outcome: "done",
      evidence: reference.url,
    });
    expect(deliveredDone).toMatchObject({
      outcome: "failed",
      detail: expect.stringContaining("owner_verification_required"),
    });
    expect(await a.store.call("get_issue", { id: a.issue.id })).toMatchObject({
      stage: "delivered",
      status: "Delivered",
      updatedByActor: expect.objectContaining({ type: "agent-worker", id: "clankie" }),
    });
    trace.deliveredOwnerFence = deliveredDone;

    const c = await fixture("c");
    const current = await c.seat("Binding changed after observation");
    await keeper.observe([current]);
    const beforeChange = await readFile(join(root, "c-store", "tracker.json"), "utf8");
    const captured = await c.service.prepareSeatIssueTracker("c", async () => {});
    c.overlap();
    await expect(
      captured.call(
        "save_comment",
        { issueId: c.issue.id, body: "must refuse changed attribution" },
        "interactive",
      ),
    ).rejects.toThrow();
    expect(
      await keeper.closed({ seatId: current.seatId, reason: "ambiguous shared workspace" }),
    ).toMatchObject({ outcome: "failed" });
    expect(await readFile(join(root, "c-store", "tracker.json"), "utf8")).toBe(beforeChange);
    trace.ambiguousWorkspace = "prepared route rejects later overlap; whole store unchanged";
    // A current scope switch to another real store with the same display key
    // cannot transfer the earlier immutable item UUID to that other issue.
    const d = await fixture("d");
    const e = await fixture("e");
    const otherBefore = await readFile(join(root, "e-store", "tracker.json"), "utf8");
    const originalSeat = await d.seat("Current binding switches scopes");
    let switchedScope = false;
    const original = originalSeat.attribution!;
    const changing: LiveSeatIssue = {
      ...originalSeat,
      attribution: {
        resolve: () =>
          switchedScope ? e.service.prepareSeatIssueTracker("e", async () => {}) : original.resolve(),
      },
    };
    await keeper.observe([changing]);
    switchedScope = true;
    const scopeChange = await keeper.closed({
      seatId: changing.seatId,
      reason: "current scope now has another LOCAL-VUH-4",
    });
    expect(scopeChange).toMatchObject({ outcome: "failed" });
    expect(await readFile(join(root, "e-store", "tracker.json"), "utf8")).toBe(otherBefore);
    trace.currentScopeSameKey = scopeChange;
    await writeConvention(d.path, { ...convention, backend: "linear", linear: { team: "VUH" } });
    await expect(d.service.prepareSeatIssueTracker("d", async () => {})).rejects.toThrow("not connected");
    trace.savedLinearDisconnected = "bound saved Linear refused; no local compatibility fallback";
    const f = await fixture("f");
    const retiredOriginal = await f.seat("Original hire");
    await keeper.observe([retiredOriginal]);
    ledger.reconcile("default", new Set(), new Set(), ledger.inventoryCandidates("default"));
    const replacement = await f.seat("Replacement native occupant", "LOCAL-VUH-4", retiredOriginal.seatId);
    const fBefore = await readFile(join(root, "f-store", "tracker.json"), "utf8");
    const replacementRefusal = await keeper.closed({
      seatId: retiredOriginal.seatId,
      reason: "changed native allocation",
    });
    expect(replacementRefusal).toMatchObject({
      outcome: "failed",
      detail: expect.stringContaining("revoked"),
    });
    await keeper.observe([replacement]);
    // Synthetic durable recovery-release fixture, isolated from the live hire ledger.
    const ledgerPath = join(root, "hires.json");
    const releasedLedger = JSON.parse(await readFile(ledgerPath, "utf8")) as {
      allocations: { pane?: string; operatorRelease?: { at: string; censusSha256: string } }[];
    };
    releasedLedger.allocations.filter((entry) => entry.pane === replacement.seatId).at(-1)!.operatorRelease =
      { at: "2026-10-12T22:00:00Z", censusSha256: "0".repeat(64) };
    await writeFile(ledgerPath, JSON.stringify(releasedLedger));
    const releaseRefusal = await keeper.closed({
      seatId: replacement.seatId,
      reason: "recovery attribution released",
    });
    expect(releaseRefusal).toMatchObject({ outcome: "failed", detail: expect.stringContaining("revoked") });
    expect(await readFile(join(root, "f-store", "tracker.json"), "utf8")).toBe(fBefore);
    trace.nativeAttribution = {
      staleRoster: "capture refused",
      pendingSession: "capture refused",
      replacementRefusal,
      releaseRefusal,
    };
    expect(await readFile(join(root, "default", "tracker.json"), "utf8")).toBe(defaultBefore);
    trace.disposableDefaultVuh4AndImportedSourceRecordsUnchanged = {
      sha256: createHash("sha256").update(defaultBefore).digest("hex"),
      bytes: Buffer.byteLength(defaultBefore),
    };
    if (process.env.LOCAL_VUH_8_PROOF)
      await writeFile(process.env.LOCAL_VUH_8_PROOF, JSON.stringify(trace, null, 2));
  } finally {
    await host.close();
    await rm(root, { recursive: true, force: true });
  }
});

it("retains saved Linear retirement for bound and legacy projects through a disposable API provider", async () => {
  const { createAccounts } = await import("../src/accounts.ts");
  const { createLinearApiTracker } = await import("../src/linear-api-tracker.ts");
  const { createLinearApiProvider, TEAM_ID, PROJECT_ID } = await import("./fixtures/linear-api-provider.ts");
  const root = await realpath(await mkdtemp(join(tmpdir(), "local-vuh-8-linear-")));
  const provider = await createLinearApiProvider({ issueCount: 2 });
  const credentials = new FileCredentialStore(join(root, "credentials.json"));
  const accounts = createAccounts({
    store: credentials,
    fetch: provider.fetch,
    apps: async () => ({
      github: {},
      linear: {
        clientId: "registered-client",
        redirectUri: "https://gateway.test/account/connections/callback",
      },
    }),
  });
  const start = await accounts.startLinear();
  if (!start.ok) throw new Error("Fixture connection failed");
  if (!(await accounts.completeLinear(start.flowId, "good-code")).ok) throw new Error("Fixture OAuth failed");
  const settings = new SettingsStore(join(root, "settings.json"));
  const host = createMcpHost({
    credentials,
    settings,
    localTracker: createLocalTracker({ directory: join(root, "default") }),
    linearApiTracker: createLinearApiTracker({ credentials, fetch: provider.fetch }),
    linearFetch: provider.fetch,
    logger: { info() {}, warn() {} },
  });
  try {
    const team = { id: TEAM_ID, name: "Clankie", key: "VUH" };
    const todo = { id: "00000000-0000-4000-8000-000000000101", name: "Todo", type: "unstarted", team };
    const started = {
      id: "00000000-0000-4000-8000-000000000102",
      name: "In Progress",
      type: "started",
      team,
    };
    provider.rows.workflowStates!.push(todo, started);
    for (const issue of provider.rows.issues!) issue.state = started;
    for (const [index, bound] of [true, false].entries()) {
      const path = join(root, `linear-${index}`);
      await mkdir(path);
      await writeConvention(path, {
        schemaVersion: 1,
        backend: "linear",
        decidedBy: "owner",
        decidedAt: "2026-10-12T00:00:00Z",
        linear: { team: "VUH", project: PROJECT_ID },
      });
      const projects = ProjectsSettingsSchema.parse({
        projects: [
          {
            id: `p-${index}`,
            name: `Linear ${index}`,
            workspaces: [{ id: "primary", machineId: "local", platform: "posix", path }],
            ...(bound ? { trackerRef: { workspaceId: "primary", path: ".clankie/tracking.json" } } : {}),
          },
        ],
      });
      const service = createWorkItemsService({
        stateDirectory: join(root, `work-${index}`),
        projects: async () => projects,
        mcpHost: host,
        localMachineId: "local",
      });
      const keeper = new SeatIssueKeeper(host, join(root, `keeper-${index}.json`), {
        requireAttribution: true,
      });
      const key = String(provider.rows.issues![index]!.identifier);
      await keeper.observe([
        {
          seatId: `s-${index}`,
          title: "Linear fixture",
          keys: [key],
          attribution: { resolve: () => service.prepareSeatIssueTracker(`p-${index}`, async () => {}) },
        },
      ]);
      expect(await keeper.closed({ seatId: `s-${index}`, reason: "saved Linear retirement" })).toMatchObject({
        outcome: "updated",
        issue: key,
        status: "Todo",
      });
      expect(provider.rows.issues![index]!.state).toMatchObject({ name: "Todo" });
      expect(
        provider.rows.comments!.some((comment) => String(comment.body).includes("saved Linear retirement")),
      ).toBe(true);
    }
    expect(provider.validationErrors).toEqual([]);
    if (process.env.LOCAL_VUH_8_LINEAR_PROOF)
      await writeFile(
        process.env.LOCAL_VUH_8_LINEAR_PROOF,
        JSON.stringify(
          {
            scope:
              "real local HTTP OAuth/GraphQL fixture through production saved Linear route; no live connected account",
            boundAndLegacy: "status/comment target passed",
            validationErrors: provider.validationErrors,
          },
          null,
          2,
        ),
      );
  } finally {
    await host.close();
    await provider.close();
    await rm(root, { recursive: true, force: true });
  }
});
