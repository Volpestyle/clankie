import { expect, it, vi } from "vitest";
import type { ProjectsSettings } from "@clankie/protocol/projects";
import { createLinearWorkProjects } from "../src/linear-work-projects.ts";

const first = "11111111-1111-4111-8111-111111111111";
const second = "22222222-2222-4222-8222-222222222222";
const project = (uuid: string, name = "Same name") => ({ id: uuid, name, leadTeam: { id: "team" } });
function fixture() {
  let binding = "account-a";
  let projects = [project(first)];
  const call = vi.fn(async (name: string, args: Record<string, unknown>): Promise<unknown> => {
    if (name === "list_projects") return { projects, hasNextPage: false };
    if (name === "list_issues")
      return {
        issues: [
          {
            id: "issue",
            identifier: "VUH-1",
            title: "Actual issue",
            status: "Todo",
            statusType: "unstarted",
            projectId: args.project,
          },
        ],
        hasNextPage: false,
      };
    if (name === "list_issue_statuses") return { statuses: [] };
    throw new Error(name);
  });
  return {
    call,
    binding: async () => binding,
    switchAccount() {
      binding = "account-b";
      projects = [project(second)];
    },
  };
}

it("reads connected Linear projects and their issues without registering a local checkout", async () => {
  const source = fixture();
  const reader = createLinearWorkProjects({ ...source, builtInRepos: async () => [], root: "/unused" });
  const repos = await reader.repos();
  const result = await reader.read({ action: "list", repo: repos[0]!.id });
  expect(result).toMatchObject({ repo: { backend: "linear" }, items: [{ id: "VUH-1" }] });
  expect(source.call.mock.calls.every(([name]) => name.startsWith("list_"))).toBe(true);
});

it("refuses another account's project reference after switching accounts", async () => {
  const source = fixture();
  const reader = createLinearWorkProjects({ ...source, builtInRepos: async () => [], root: "/unused" });
  const old = (await reader.repos())[0]!;
  source.switchAccount();
  await expect(reader.read({ action: "list", repo: old.id })).rejects.toThrow("not available");
  expect(source.call.mock.calls.filter(([name]) => name === "list_issues")).toHaveLength(0);
});

it("refuses an account change during an in-flight project read", async () => {
  const source = fixture();
  const original = source.call;
  const reader = createLinearWorkProjects({
    ...source,
    call: async (name, args) => {
      const result = await original(name, args);
      if (name === "list_issues") source.switchAccount();
      return result;
    },
    builtInRepos: async () => [],
    root: "/unused",
  });
  await expect(reader.read({ action: "list", repo: `linear-${first}` })).rejects.toThrow("account changed");
});

it("does not duplicate a project cut over to the built-in tracker", async () => {
  const source = fixture();
  const reader = createLinearWorkProjects({
    ...source,
    builtInRepos: async () => [
      {
        id: "builtin",
        projectId: "work",
        name: "Work",
        backend: "builtin",
        trackerProjectId: first,
        needsDecision: false,
      },
    ],
    root: "/unused",
  });
  expect(await reader.repos()).toEqual([]);
  await expect(reader.read({ action: "list", repo: `linear-${first}` })).rejects.toThrow("not available");
});

it("associates a World project only through one exact saved UUID, never its name", async () => {
  const source = fixture();
  const settings = {
    projects: [
      { id: "wrong", name: "Same name", linearProjectBinding: { provider: "linear", projectId: second } },
      { id: "right", name: "Different name", linearProjectBinding: { provider: "linear", projectId: first } },
    ],
  } as ProjectsSettings;
  const reader = createLinearWorkProjects({
    ...source,
    projects: async () => settings,
    builtInRepos: async () => [],
    root: "/unused",
  });
  expect(await reader.repos()).toMatchObject([{ projectId: "right" }]);
  settings.projects.push({ ...settings.projects[1]!, id: "ambiguous" });
  expect((await reader.repos())[0]!.projectId).toBeUndefined();
});

it("follows every project page and rejects a repeated cursor", async () => {
  const source = fixture();
  const reader = createLinearWorkProjects({
    ...source,
    call: async (_name, args) =>
      args.cursor
        ? { projects: [project(second)], hasNextPage: false }
        : { projects: [project(first)], hasNextPage: true, cursor: "next" },
    builtInRepos: async () => [],
    root: "/unused",
  });
  expect(await reader.repos()).toHaveLength(2);
  const broken = createLinearWorkProjects({
    ...source,
    call: async () => ({ projects: [project(first)], hasNextPage: true, cursor: "same" }),
    builtInRepos: async () => [],
    root: "/unused",
  });
  await expect(broken.repos()).rejects.toThrow("Incomplete");
});

it("accepts canonical GraphQL team connections", async () => {
  const source = fixture();
  const reader = createLinearWorkProjects({
    ...source,
    call: async (name, args) =>
      name === "list_projects"
        ? {
            projects: [{ id: first, name: "GraphQL project", teams: { nodes: [{ id: "team" }] } }],
            hasNextPage: false,
          }
        : source.call(name, args),
    builtInRepos: async () => [],
    root: "/unused",
  });
  expect(await reader.read({ action: "list", repo: `linear-${first}` })).toMatchObject({
    items: [{ id: "VUH-1" }],
  });
});

it("keeps an unavailable cutover's old Linear mirror out of the list", async () => {
  const source = fixture();
  const reader = createLinearWorkProjects({
    ...source,
    projects: async () => ({ projects: [{ id: "work", trackerProjectId: first }] }) as ProjectsSettings,
    builtInRepos: async () => [
      {
        id: "builtin",
        projectId: "work",
        name: "Work",
        needsDecision: false,
        unavailable: "Workspace unavailable",
      },
    ],
    root: "/unused",
  });
  expect(await reader.repos()).toEqual([]);
});

it("reads a project across all its teams", async () => {
  const source = fixture();
  const reader = createLinearWorkProjects({
    ...source,
    call: async (name, args) => {
      if (name === "list_projects")
        return {
          projects: [{ id: first, name: "Shared", teams: { nodes: [{ id: "team-a" }, { id: "team-b" }] } }],
          hasNextPage: false,
        };
      if (name === "list_issues") expect(args).not.toHaveProperty("team");
      return source.call(name, args);
    },
    builtInRepos: async () => [],
    root: "/unused",
  });
  await reader.read({ action: "list", repo: `linear-${first}` });
});

it.each(["show", "activity"] as const)("refuses %s for an issue from another project", async (action) => {
  const source = fixture();
  const reader = createLinearWorkProjects({
    ...source,
    call: async (name, args) =>
      name === "get_issue" ? { id: "foreign", title: "Foreign", projectId: second } : source.call(name, args),
    builtInRepos: async () => [],
    root: "/unused",
  });
  await expect(reader.read({ action, repo: `linear-${first}`, id: "VUH-2" })).rejects.toThrow(
    "another project",
  );
});
