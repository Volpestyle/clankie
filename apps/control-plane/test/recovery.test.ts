import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { compileDoctrine, loadDoctrineFile } from "@clankie/doctrine";
import { SqliteEventStore } from "@clankie/event-store";
import { beforeAll, describe, expect, it } from "vitest";
import { createControlPlane } from "../src/app.ts";

const captainHeaders = {
  authorization: "Bearer captain-secret",
  "content-type": "application/json",
};
const runnerHeaders = {
  authorization: "Bearer runner-secret",
  "content-type": "application/json",
};

let doctrine: Awaited<ReturnType<typeof compileDoctrine>>;

beforeAll(async () => {
  doctrine = compileDoctrine([
    await loadDoctrineFile(resolve(import.meta.dirname, "../../../doctrine/profiles/self-build-lab.yaml")),
  ]);
});

describe("control-plane recovery", () => {
  const unitCheckIdentity = `runner-check:unit:sha256:${"a".repeat(64)}`;
  const weakenedCheckIdentity = `runner-check:unit:sha256:${"b".repeat(64)}`;

  it("authenticates, persists, replays, and resolves one bounded recovery pair", async () => {
    const directory = await mkdtemp(join(tmpdir(), "clankie-recovery-"));
    const path = join(directory, "events.db");
    let store = new SqliteEventStore(path);
    const dependencies = {
      doctrine,
      authenticateCaptain: (request: Request) =>
        Promise.resolve(
          request.headers.get("authorization") === "Bearer captain-secret"
            ? { captainId: "captain" }
            : undefined,
        ),
      authenticateRunner: (request: Request) =>
        Promise.resolve(
          request.headers.get("authorization") === "Bearer runner-secret"
            ? { runnerId: "runner" }
            : undefined,
        ),
    };
    let control = await createControlPlane({ ...dependencies, eventStore: store });
    const created = await control.request("/v1/missions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ goal: "recover unchanged checks" }),
    });
    const { missionId } = (await created.json()) as { missionId: string };
    const plan = {
      missionId,
      goal: "recover unchanged checks",
      rationale: "exercise production recovery",
      tasks: [
        {
          id: "implement",
          title: "Implement",
          objective: "write candidate",
          kind: "implementation",
          role: "implementer",
          writeScope: ["src/**"],
          successCriteria: ["candidate exists"],
          evidenceRequirements: ["diff"],
        },
        {
          id: "verify",
          title: "Verify",
          objective: "run trusted checks",
          kind: "verification",
          role: "verifier",
          dependsOn: ["implement"],
          successCriteria: ["checks pass"],
          evidenceRequirements: ["test report"],
        },
      ],
      successCriteria: ["reverification passes"],
      profileHash: doctrine.profileHash,
    };
    expect(
      (
        await control.request(`/v1/missions/${missionId}/plan`, {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(plan),
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await control.request(`/v1/missions/${missionId}/start`, {
          method: "POST",
          headers: captainHeaders,
        })
      ).status,
    ).toBe(202);

    const workers = [
      worker("codex-implementation", "codex", ["implementation"], true),
      worker("claude-verification", "claude", ["verification"], false),
      worker("pi-debugging", "pi", ["debugging"], true),
    ];
    const implementation = await claim(control, "implement", workers);
    await settle(control, implementation, {
      status: "succeeded",
      summary: "candidate written",
      evidence: [{ kind: "diff", label: "candidate", summary: "src changed" }],
      outputs: {},
    });
    const verification = await claim(control, "verify", workers);
    expect(verification.task.id).toBe("verify");
    await settle(control, verification, {
      status: "failed",
      summary: "unit failed",
      diagnosis: "unit exited 1",
      evidence: [
        { kind: "test_report", label: unitCheckIdentity, summary: "unit exited 1" },
        { kind: "log", label: "runner-check-output-metadata:unit", summary: "opaque hash" },
      ],
      outputs: {},
    });

    const recovery = {
      commandId: "recovery-command-1",
      failedTaskId: "verify",
      debugger: {
        id: "debug",
        title: "Debug",
        objective: "repair the observed failure",
        kind: "debugging",
        role: "debugger",
        dependsOn: ["implement"],
        writeScope: ["src/**"],
        successCriteria: ["root cause fixed"],
        evidenceRequirements: ["diff and diagnosis"],
      },
      reverify: {
        id: "reverify",
        title: "Reverify",
        objective: "rerun unchanged trusted checks",
        kind: "verification",
        role: "verifier",
        dependsOn: ["debug"],
        successCriteria: ["original checks pass"],
        evidenceRequirements: ["test report"],
      },
    };
    expect(
      (
        await control.request(`/v1/missions/${missionId}/recovery`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(recovery),
        })
      ).status,
    ).toBe(401);
    const accepted = await control.request(`/v1/missions/${missionId}/recovery`, {
      method: "POST",
      headers: captainHeaders,
      body: JSON.stringify(recovery),
    });
    expect(accepted.status).toBe(202);
    expect(await accepted.json()).toMatchObject({
      accepted: true,
      pair: {
        debugger: {
          spec: {
            metadata: {
              recovery: {
                failedTaskId: "verify",
                diagnosis: "unit exited 1",
                requiredCheckIdentities: [unitCheckIdentity],
              },
            },
          },
        },
      },
    });
    const reservedMetadata = await control.request(`/v1/missions/${missionId}/recovery`, {
      method: "POST",
      headers: captainHeaders,
      body: JSON.stringify({
        ...recovery,
        commandId: "forged-recovery-command",
        debugger: { ...recovery.debugger, metadata: { recovery: { failedTaskId: "forged" } } },
      }),
    });
    expect(reservedMetadata.status).toBe(409);
    await expect(reservedMetadata.json()).resolves.toMatchObject({ error: "invalid_recovery" });
    expect(
      (
        await control.request(`/v1/missions/${missionId}/recovery`, {
          method: "POST",
          headers: captainHeaders,
          body: JSON.stringify(recovery),
        })
      ).status,
    ).toBe(202);
    const conflict = await control.request(`/v1/missions/${missionId}/recovery`, {
      method: "POST",
      headers: captainHeaders,
      body: JSON.stringify({ ...recovery, debugger: { ...recovery.debugger, title: "Different" } }),
    });
    expect(conflict.status).toBe(409);
    await expect(conflict.json()).resolves.toMatchObject({ error: "conflicting_recovery_command" });

    const durablePrefix = await store.readAll();
    const recoveryEvent = durablePrefix.find((entry) => entry.event.type === "recovery.pair.added")?.event;
    expect(recoveryEvent).toBeDefined();
    const verificationSettlementIndex = durablePrefix.findIndex(
      (entry) => entry.event.type === "worker.settled" && entry.event.taskId === "verify",
    );
    expect(verificationSettlementIndex).toBeGreaterThan(0);
    const settlementPrefixStore = new SqliteEventStore(join(directory, "settlement-prefix.db"));
    for (const entry of durablePrefix.slice(0, verificationSettlementIndex + 1)) {
      await settlementPrefixStore.append(entry.event);
    }
    expect((await settlementPrefixStore.readAll()).at(-1)?.event.type).toBe("worker.settled");
    expect(
      (await settlementPrefixStore.readAll()).some(
        (entry) => entry.event.type === "task.failed" && entry.event.taskId === "verify",
      ),
    ).toBe(false);
    settlementPrefixStore.close();
    const reopenedSettlementPrefix = new SqliteEventStore(join(directory, "settlement-prefix.db"));
    const settlementPrefixControl = await createControlPlane({
      ...dependencies,
      eventStore: reopenedSettlementPrefix,
    });
    await expect(
      (await settlementPrefixControl.request(`/v1/missions/${missionId}`)).json(),
    ).resolves.toMatchObject({
      tasks: expect.arrayContaining([
        expect.objectContaining({
          spec: expect.objectContaining({ id: "verify" }),
          state: "failed",
          result: expect.objectContaining({
            diagnosis: "unit exited 1",
            evidence: expect.arrayContaining([
              expect.objectContaining({ kind: "test_report", label: unitCheckIdentity }),
            ]),
          }),
        }),
      ]),
    });
    expect(
      (
        await settlementPrefixControl.request(`/v1/missions/${missionId}/recovery`, {
          method: "POST",
          headers: captainHeaders,
          body: JSON.stringify(recovery),
        })
      ).status,
    ).toBe(202);
    reopenedSettlementPrefix.close();

    const prefixStore = new SqliteEventStore(join(directory, "partial-prefix.db"));
    for (const entry of durablePrefix) {
      if (entry.event.type === "recovery.pair.added") break;
      await prefixStore.append(entry.event);
    }
    await prefixStore.append({
      ...recoveryEvent!,
      id: "legacy-partial-debugger-task-added",
      type: "task.added",
      taskId: "debug",
      data: { spec: recoveryEvent!.data.debuggerSpec },
    });
    const prefixControl = await createControlPlane({ ...dependencies, eventStore: prefixStore });
    const prefixSnapshot = (await (await prefixControl.request(`/v1/missions/${missionId}`)).json()) as {
      tasks: Array<{ spec: { id: string } }>;
    };
    expect(prefixSnapshot.tasks.map((task) => task.spec.id)).toEqual(["implement", "verify"]);
    expect(
      (
        await prefixControl.request("/v1/runner/claims", {
          method: "POST",
          headers: runnerHeaders,
          body: JSON.stringify({ claimId: "partial-orphan", workers }),
        })
      ).status,
    ).toBe(204);
    expect(
      (
        await prefixControl.request(`/v1/missions/${missionId}/recovery`, {
          method: "POST",
          headers: captainHeaders,
          body: JSON.stringify(recovery),
        })
      ).status,
    ).toBe(202);
    expect(
      (
        await prefixControl.request("/v1/runner/claims", {
          method: "POST",
          headers: runnerHeaders,
          body: JSON.stringify({ claimId: "partial-retry", workers }),
        })
      ).status,
    ).toBe(200);
    prefixStore.close();

    store.close();
    store = new SqliteEventStore(path);
    control = await createControlPlane({ ...dependencies, eventStore: store });
    const afterRestart = (await (await control.request(`/v1/missions/${missionId}`)).json()) as {
      tasks: Array<{ spec: { id: string } }>;
    };
    expect(afterRestart.tasks.map((task) => task.spec.id)).toEqual([
      "implement",
      "verify",
      "debug",
      "reverify",
    ]);

    const debugging = await claim(control, "debug", workers);
    expect(debugging.worker.id).toBe("pi-debugging");
    expect(
      (
        await settle(control, debugging, {
          status: "succeeded",
          summary: "root cause repaired",
          evidence: [{ kind: "diff", label: "fix", summary: "source fixed" }],
          outputs: {},
        })
      ).status,
    ).toBe(200);
    const reverification = await claim(control, "reverify", workers);
    expect(reverification.worker.id).toBe("claude-verification");
    const mismatch = await settle(control, reverification, {
      status: "succeeded",
      summary: "wrong check",
      evidence: [
        {
          kind: "test_report",
          label: weakenedCheckIdentity,
          summary: "the same id was weakened to /usr/bin/true",
        },
      ],
      outputs: {},
    });
    expect(mismatch.status).toBe(409);
    await expect(mismatch.json()).resolves.toMatchObject({
      error: "recovery_verification_checks_mismatch",
      expected: [unitCheckIdentity],
      actual: [weakenedCheckIdentity],
    });
    expect(
      (
        await settle(control, reverification, {
          status: "succeeded",
          summary: "unit passed unchanged",
          evidence: [{ kind: "test_report", label: unitCheckIdentity, summary: "unit exited 0" }],
          outputs: {},
        })
      ).status,
    ).toBe(200);
    const final = (await (await control.request(`/v1/missions/${missionId}`)).json()) as {
      state: string;
      tasks: Array<{ spec: { id: string }; state: string }>;
    };
    expect(final.state).toBe("succeeded");
    expect(final.tasks.find((task) => task.spec.id === "verify")?.state).toBe("failed");
    const stored = await store.readAll();
    expect(stored.filter((entry) => entry.event.type === "task.added")).toHaveLength(0);
    expect(stored.filter((entry) => entry.event.type === "recovery.pair.added")).toHaveLength(1);
    expect(stored.filter((entry) => entry.event.type === "task.failure.resolved")).toHaveLength(1);
    expect(stored.filter((entry) => entry.event.type === "mission.succeeded")).toHaveLength(1);
    expect(stored.find((entry) => entry.event.type === "recovery.pair.added")?.event.data).toMatchObject({
      debuggerSpec: { id: "debug", metadata: expect.any(Object) },
      reverifySpec: { id: "reverify", metadata: expect.any(Object) },
    });

    store.close();
    store = new SqliteEventStore(path);
    const replayed = await createControlPlane({ ...dependencies, eventStore: store });
    await expect((await replayed.request(`/v1/missions/${missionId}`)).json()).resolves.toMatchObject({
      state: "succeeded",
      tasks: expect.arrayContaining([
        expect.objectContaining({ spec: expect.objectContaining({ id: "verify" }), state: "failed" }),
        expect.objectContaining({ spec: expect.objectContaining({ id: "reverify" }), state: "succeeded" }),
      ]),
    });
    expect((await store.readAll()).filter((entry) => entry.event.type === "mission.succeeded")).toHaveLength(
      1,
    );
    store.close();
  });
});

function worker(id: string, harness: "codex" | "claude" | "pi", kinds: string[], canWrite: boolean) {
  return {
    id,
    displayName: id,
    harness,
    capabilities: {
      kinds,
      canWrite,
      supportsStructuredEvents: true,
      supportsTerminal: true,
      supportsNativeSession: true,
    },
  };
}

type Assignment = {
  workerRunId: string;
  attempt: number;
  task: { id: string };
  worker: { id: string };
};

async function claim(
  control: Awaited<ReturnType<typeof createControlPlane>>,
  claimId: string,
  workers: unknown[],
): Promise<Assignment> {
  const response = await control.request("/v1/runner/claims", {
    method: "POST",
    headers: runnerHeaders,
    body: JSON.stringify({ claimId, workers }),
  });
  expect(response.status).toBe(200);
  return ((await response.json()) as { assignment: Assignment }).assignment;
}

async function settle(
  control: Awaited<ReturnType<typeof createControlPlane>>,
  assignment: Assignment,
  result: Record<string, unknown>,
): Promise<Response> {
  return control.request(`/v1/runner/workers/${assignment.workerRunId}/settle`, {
    method: "POST",
    headers: runnerHeaders,
    body: JSON.stringify({ attempt: assignment.attempt, result }),
  });
}
