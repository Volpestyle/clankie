import { readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";
import { projectRoleForPersona } from "@clankie/settings";
import { runAgentsCommand } from "../../tui/src/command/agents.ts";
import { occupantIdForHerdrSession } from "../src/captain/herdr-census.ts";
import { personaProjectRoleFixture as fixture } from "./persona-project-role-fixture.ts";

it("writes and clears a nondefault member's role through the owner CLI and projects the current station", async () => {
  const f = await fixture();
  const ledger = await readFile(join(f.directory, "herdr-watches.json.project-hires.json"), "utf8");
  expect(
    await runAgentsCommand(["role", "Pixel", "Smith", "tester", "--project", "repo"], f.options),
  ).toMatchObject({ personaId: f.ids[0], role: "tester" });
  expect(projectRoleForPersona((await f.settings.load()).projects, f.ids[0]!, "repo")).toBe("tester");
  expect(projectRoleForPersona((await f.settings.load()).projects, f.ids[0]!)).toBeUndefined();
  expect(await f.readMembership(0)).toMatchObject({
    seats: [
      {
        membership: {
          outcome: "member",
          projectId: "repo",
          role: "tester",
        },
      },
    ],
  });
  await f.client.setPersonaRole!(f.ids[0]!, null, "repo");
  const cleared = await f.readMembership(0);
  expect(cleared.seats[0].membership).toEqual({ outcome: "member", source: "hire", projectId: "repo" });
  expect(await readFile(join(f.directory, "herdr-watches.json.project-hires.json"), "utf8")).toBe(ledger);
  const identities = JSON.parse(await readFile(join(f.directory, "personas.json"), "utf8"));
  expect(identities.personas.every((persona: Record<string, unknown>) => !("role" in persona))).toBe(true);
});

it.each(["workspace", "remote"] as const)(
  "assigns a %s member's role through the owner CLI without changing its hire ledger",
  async (mode) => {
    const f = await fixture(mode);
    const index = mode === "workspace" ? 2 : 0;
    const name = mode === "workspace" ? ["Unconfirmed", "Worker"] : ["Pixel", "Smith"];
    const ledger = await readFile(join(f.directory, "herdr-watches.json.project-hires.json"), "utf8");
    expect(await runAgentsCommand(["role", ...name, "tester", "--project", "repo"], f.options)).toMatchObject(
      { personaId: f.ids[index], role: "tester" },
    );
    expect(projectRoleForPersona((await f.settings.load()).projects, f.ids[index]!, "repo")).toBe("tester");
    expect(await f.readMembership(index)).toMatchObject({
      seats: [
        {
          membership: {
            outcome: "member",
            source: mode === "workspace" ? "workspace" : "hire",
            projectId: "repo",
            role: "tester",
          },
        },
      ],
    });
    expect(await readFile(join(f.directory, "herdr-watches.json.project-hires.json"), "utf8")).toBe(ledger);
  },
);

it("keeps old-client omission on a real default member and refuses foreign or unconfirmed members", async () => {
  const f = await fixture();
  expect(await f.client.setPersonaRole!(f.ids[1]!, "reviewer")).toMatchObject({
    personaId: f.ids[1],
    role: "reviewer",
  });
  expect(await f.readMembership(1)).toMatchObject({
    seats: [
      {
        membership: {
          outcome: "member",
          projectId: "default",
          role: "reviewer",
        },
      },
    ],
  });
  const before = await readFile(f.settings.path, "utf8");
  await expect(f.client.setPersonaRole!(f.ids[0]!, "designer")).rejects.toThrow(
    "not a confirmed current member",
  );
  await expect(f.client.setPersonaRole!(f.ids[1]!, "designer", "repo")).rejects.toThrow(
    "not a confirmed current member",
  );
  await expect(f.client.setPersonaRole!(f.ids[2]!, "designer", "repo")).rejects.toThrow(
    "not a confirmed current member",
  );
  expect(await readFile(f.settings.path, "utf8")).toBe(before);
});

it("refuses revocation during the native membership read before durable role intent", async () => {
  const f = await fixture();
  const before = await readFile(f.settings.path, "utf8");
  f.onObserve(async () => f.revoke());
  await expect(f.client.setPersonaRole!(f.ids[0]!, "tester", "repo")).rejects.toThrow(
    "captain_authentication_required",
  );
  expect(await readFile(f.settings.path, "utf8")).toBe(before);
  const journal = (await readdir(f.directory)).find((file) => file.endsWith(".pending.json"));
  expect(journal && (await readFile(join(f.directory, journal), "utf8"))).toBeUndefined();
});

it.each(["occupant", "project"] as const)(
  "refuses a %s change without recording a role intent",
  async (change) => {
    const f = await fixture();
    const before = await readFile(f.settings.path, "utf8");
    const assignments = (await f.settings.load()).projects.assignments;
    f.onObserve(async () => {
      if (change === "occupant") f.panes[0]!.agent_session.value = "replacement-native-session";
      else
        await f.settings.update((current) => ({
          ...current,
          projects: {
            ...current.projects,
            projects: current.projects.projects.map((project) => ({ ...project, name: "Owner edit" })),
          },
        }));
    });
    await expect(f.client.setPersonaRole!(f.ids[0]!, "tester", "repo")).rejects.toThrow(/member/);
    if (change === "occupant") expect(await readFile(f.settings.path, "utf8")).toBe(before);
    expect((await f.settings.load()).projects.assignments).toEqual(assignments);
    expect((await readdir(f.directory)).filter((file) => file.endsWith(".pending.json"))).toEqual([]);
  },
);

it("keeps one-positional role profile editing on the existing owner settings API", async () => {
  const f = await fixture();
  await runAgentsCommand(
    ["role", "builder", "--project", "repo", "--harness", "codex", "--effort", "medium"],
    f.options,
  );
  const projects = (await f.settings.load()).projects;
  expect(
    projects.projects.find((project) => project.id === "repo")!.roles.find((role) => role.role === "builder"),
  ).toMatchObject({ role: "builder", harness: "codex", effort: "medium" });
  expect(projectRoleForPersona(projects, f.ids[0]!, "repo")).toBe("builder");
  await expect(
    runAgentsCommand(
      ["role", "Pixel", "Smith", "tester", "--project", "repo", "--harness", "codex"],
      f.options,
    ),
  ).rejects.toThrow("Usage");
});

it("fences an owner CLI World role drop to its original free native occupant and project", async () => {
  const f = await fixture("free");
  const intent = {
    personaId: f.ids[0]!,
    seatId: f.panes[0]!.terminal_id,
    occupantId: occupantIdForHerdrSession(f.panes[0]!.agent_session),
    projectId: "repo",
  };
  expect(
    await runAgentsCommand(
      ["role", f.ids[0]!, "tester", "--project", "repo", "--free-agent", JSON.stringify(intent)],
      f.options,
    ),
  ).toMatchObject({ personaId: f.ids[0], role: "tester" });
  const before = await readFile(join(f.directory, "settings.json"), "utf8");
  await expect(
    f.client.setPersonaRole!(f.ids[0]!, "designer", "repo", { ...intent, occupantId: "replacement" }),
  ).rejects.toThrow(/original agent|changed/);
  await expect(f.client.setPersonaRole!(f.ids[0]!, "designer", "default", intent)).rejects.toThrow(
    /original agent|project/,
  );
  expect(await readFile(join(f.directory, "settings.json"), "utf8")).toBe(before);
});

it("refuses a World drop that becomes busy during native membership admission without changing its role", async () => {
  const f = await fixture("free");
  const intent = {
    personaId: f.ids[0]!,
    seatId: f.panes[0]!.terminal_id,
    occupantId: occupantIdForHerdrSession(f.panes[0]!.agent_session),
    projectId: "repo",
  };
  const before = await readFile(join(f.directory, "settings.json"), "utf8");
  f.onObserve(async () => {
    f.panes[0]!.agent_status = "working";
  });
  await expect(f.client.setPersonaRole!(f.ids[0]!, "tester", "repo", intent)).rejects.toThrow(
    /original agent|free/,
  );
  expect(await readFile(join(f.directory, "settings.json"), "utf8")).toBe(before);
});

it("requires observed zero native children and refuses a child started during membership admission", async () => {
  const unknown = await fixture();
  const intent = {
    personaId: unknown.ids[0]!,
    seatId: unknown.panes[0]!.terminal_id,
    occupantId: occupantIdForHerdrSession(unknown.panes[0]!.agent_session),
    projectId: "repo",
  };
  await expect(unknown.client.setPersonaRole!(unknown.ids[0]!, "tester", "repo", intent)).rejects.toThrow(
    /free|original/,
  );
  const f = await fixture("free");
  const original = {
    ...intent,
    personaId: f.ids[0]!,
    occupantId: occupantIdForHerdrSession(f.panes[0]!.agent_session),
  };
  const before = await readFile(join(f.directory, "settings.json"), "utf8");
  f.onObserve(async () => {
    await writeFile(
      join(f.directory, "sessions", "2026", "10", "08", "rollout-child.jsonl"),
      JSON.stringify({
        type: "session_meta",
        timestamp: "2026-10-08T12:00:01.000Z",
        payload: {
          id: "01a107ed-051f-7283-887c-2939399a0ca3",
          parent_thread_id: "01a107e9-f3b1-7181-ad0e-744661b18961",
          timestamp: "2026-10-08T12:00:01.000Z",
          thread_source: "subagent",
        },
      }) + "\n",
    );
  });
  await expect(f.client.setPersonaRole!(f.ids[0]!, "tester", "repo", original)).rejects.toThrow(
    /free|original/,
  );
  expect(await readFile(join(f.directory, "settings.json"), "utf8")).toBe(before);
});
