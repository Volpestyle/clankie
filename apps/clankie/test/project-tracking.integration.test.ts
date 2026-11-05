import { randomBytes } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { once } from "node:events";
import { join, resolve } from "node:path";
import { readFile } from "node:fs/promises";
import { serve } from "@hono/node-server";
import { afterEach, expect, it } from "vitest";
import { FileCredentialStore, mintOperatorToken, OPERATOR_CREDENTIAL_PROVIDER_ID } from "@clankie/credential-broker";
import { SettingsStore } from "@clankie/settings";
import { ProjectsSettingsSchema } from "@clankie/protocol/projects";
import { PROJECT_TRACKING_PATH, type ProjectTracking } from "@clankie/protocol/project-tracking";
import { hostedOperatorAllows } from "@clankie/protocol/hosted-operator";
import { publicGatewayTargetFor } from "@clankie/protocol/public-gateway";
import { createClankieApp } from "../src/app.ts";
import { createStubCaptain } from "../src/captain/port.ts";
import { createCredentialBackedOperatorAuthenticator } from "../src/operator-auth.ts";
import { ProjectTrackingService } from "../src/project-tracking.ts";
import { trackingBlock } from "../src/project-tracking-guide.ts";
import { trackingForge } from "./fixtures/project-tracking-forge.ts";
import { createProjectWorkReader } from "../src/project-work-items.ts";

const exec = promisify(execFile);
const cleanup: (() => unknown | Promise<unknown>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
const guide = "# Owner before\r\n\r\n<!-- clankie:tracking -->\r\nOld tracker text\r\n<!-- /clankie:tracking -->\r\n\r\nOwner after π\r\n";
async function fixture(text = guide, mode = "100644") {
  const forge = await trackingForge(); cleanup.push(() => forge.close());
  const publicRepo = await forge.repo("fixture/garden", text, false, "CLAUDE.md", mode);
  const privateRepo = await forge.repo("fixture/garden-private", guide, true, "AGENTS.md");
  const setting: ProjectTracking = {
    repositories: [
      { repository: "fixture/garden", visibility: "public", guide: "CLAUDE.md" },
      { repository: "fixture/garden-private", visibility: "private", guide: "AGENTS.md" },
    ],
    tracker: { backend: "github", public: { repository: "fixture/garden", board: "https://github.com/users/fixture/projects/1" }, private: { repository: "fixture/garden-private", board: "https://github.com/users/fixture/projects/2" } },
  };
  const settings = new SettingsStore(join(forge.root, "settings.json"));
  await settings.update((current) => ({ ...current, projects: ProjectsSettingsSchema.parse({ projects: [{ id: "garden", name: "Garden" }] }) }));
  let account = true, owner = true;
  const service = new ProjectTrackingService(settings, async () => ({ api: forge.api, assertCurrent: () => { if (!account) throw new Error("Connection replaced"); } }));
  const credentials = new FileCredentialStore(join(forge.root, "credentials.json"));
  const token = mintOperatorToken(); await credentials.set(OPERATOR_CREDENTIAL_PROVIDER_ID, { type: "api", key: token });
  const authenticate = createCredentialBackedOperatorAuthenticator({ store: credentials, env: {}, identity: { operatorId: "fixture-owner" } });
  const app = await createClankieApp({
    captain: createStubCaptain(), settings, projectTracking: service,
    eventLogPath: join(forge.root, "events.jsonl"), deviceSessionKey: randomBytes(32),
    authenticateOperator: async (request) => owner ? authenticate(request) : undefined,
  });
  const server = serve({ hostname: "127.0.0.1", port: 0, fetch: app.app.fetch });
  if (!server.listening) await once(server, "listening");
  const base = "http://127.0.0.1:" + (server.address() as { port: number }).port;
  cleanup.push(async () => { if ("closeAllConnections" in server) server.closeAllConnections(); await new Promise<void>((done) => server.close(() => done())); await app.close(); });
  const request = (body?: unknown, bearer = token) => fetch(base + PROJECT_TRACKING_PATH + (body ? "" : "?projectId=garden"), {
    method: body ? "POST" : "GET", headers: { authorization: `Bearer ${bearer}`, "content-type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const read = async () => { const response = await request(); expect(response.status).toBe(200); return response.json(); };
  const cli = async (...args: string[]) => {
    const result = await exec(process.execPath, [resolve(import.meta.dirname, "../../tui/bin/clankie.ts"), "project", "tracking", "garden", ...args], {
      env: { ...process.env, CLANKIE_CONTROL_PLANE_URL: base, CLANKIE_OPERATOR_TOKEN: token, CLANKIE_STATE: join(forge.root, "cli"), NODE_ENV: "test", VITEST: "true" }, timeout: 15000,
    });
    return JSON.parse(result.stdout);
  };
  const apply = async (selection = setting) => cli("apply", JSON.stringify(selection), "--revision", (await read()).revision);
  return { forge, publicRepo, privateRepo, setting, settings, service, request, read, cli, apply,
    revokeAccount: () => { account = false; }, revokeOwner: () => { owner = false; },
  };
}

it("applies the setting through the actual CLI/API and proposes only marked bytes in its own fixture repos", async () => {
  const f = await fixture();
  const before = await f.cli();
  expect(before.decision).toBe("confirmation_required");
  const preview = await f.cli("preview", JSON.stringify(f.setting));
  expect(preview.proposed).toEqual(f.setting);
  expect(f.forge.calls).toHaveLength(0);
  const result = await f.apply();
  expect(result.selection).toEqual(f.setting);
  expect(result.guides.map((entry: any) => entry.state)).toEqual(["pull_request", "pull_request"]);
  for (const [repo, file] of [[f.publicRepo, "CLAUDE.md"], [f.privateRepo, "AGENTS.md"]] as const) {
    expect(repo.pulls).toHaveLength(1);
    const branch = repo.pulls[0].head.ref;
    expect(await repo.diff(branch)).toBe(file + "\n");
    expect(await repo.read()).toBe(guide);
    const proposed = await repo.read(branch);
    expect(proposed.split("<!-- clankie:tracking -->")[0]).toBe(guide.split("<!-- clankie:tracking -->")[0]);
    expect(proposed.split("<!-- /clankie:tracking -->")[1]).toBe(guide.split("<!-- /clankie:tracking -->")[1]);
    expect(proposed).toContain("GitHub issues in `fixture/garden`");
    expect(proposed).toContain("\r\n");
  }
  expect(await f.publicRepo.read(f.publicRepo.pulls[0].head.ref)).not.toContain("garden-private");
  expect(await f.publicRepo.read(f.publicRepo.pulls[0].head.ref)).not.toContain("projects/2");
  const writes = f.forge.calls.filter((call) => call.method === "POST").length;
  expect((await f.cli("sync", "--revision", result.revision)).guides.every((entry: any) => entry.state === "pull_request")).toBe(true);
  expect(f.forge.calls.filter((call) => call.method === "POST")).toHaveLength(writes);
  await f.publicRepo.merge(); await f.privateRepo.merge();
  const confirmed = await f.cli("sync", "--revision", result.revision);
  expect(confirmed.guides.map((entry: any) => entry.state)).toEqual(["matches", "matches"]);
  // The writer never changes local files or migrates issues: every forge mutation is scoped.
  expect(f.forge.calls.filter((call) => call.method === "POST").every((call) => /^\/repos\/fixture\/garden(?:-private)?\/(git\/(trees|commits|refs)|pulls)$/u.test(call.path))).toBe(true);
  expect((await readFile(join(f.forge.root, "settings.json"), "utf8"))).not.toContain("fixture-only");
});

it.each([
  ["missing", "Owner-only guide\n", "100644"],
  ["reversed", "<!-- /clankie:tracking -->\n<!-- clankie:tracking -->\n", "100644"],
  ["duplicate", guide + guide, "100644"],
  ["partial", "<!-- clankie:tracking -->\ncontent\n", "100644"],
  ["inline", "owner <!-- clankie:tracking -->\ncontent\n<!-- /clankie:tracking -->\n", "100644"],
  ["malformed end", "<!-- clankie:tracking -->\ncontent\n<!-- /clankie:tracking -->extra\n", "100644"],
  ["symlink", guide, "120000"],
])("refuses a %s guide without guessing or writing its repository", async (_name, text, mode) => {
  const f = await fixture(text, mode);
  const result = await f.apply();
  expect(result.guides[0].state).toBe("refused");
  expect(f.publicRepo.pulls).toHaveLength(0);
  expect(f.forge.calls.filter((call) => call.method === "POST" && call.path.startsWith("/repos/fixture/garden/"))).toHaveLength(0);
  expect(await f.publicRepo.read()).toBe(text);
});

it.each(["owner", "account", "setting"] as const)("refuses publication if %s changes while the guide read is pending", async (change) => {
  const f = await fixture();
  const configured = await f.apply();
  // Close the first PR unmerged so a new drift proposal would otherwise be created.
  f.publicRepo.pulls[0].state = "closed"; f.privateRepo.pulls[0].state = "closed";
  const before = f.forge.calls.filter((call) => call.method === "POST").length;
  f.forge.before(async (method, path) => {
    if (method !== "GET" || !path.includes("git/blobs/")) return;
    f.forge.before();
    if (change === "owner") f.revokeOwner();
    else if (change === "account") f.revokeAccount();
    else await f.settings.update((current) => ({ ...current, projects: { ...current.projects, projects: current.projects.projects.map((project) => ({ ...project, tracking: undefined })) } }));
  });
  await expect(f.cli("sync", "--revision", configured.revision)).rejects.toThrow();
  expect(f.forge.calls.filter((call) => call.method === "POST")).toHaveLength(before);
});

it("infers one explicit repo grouping and targets, but only proposes later tracker changes", async () => {
  const f = await fixture();
  const privateGuide = "Owner text\n<!-- clankie:tracking -->\n" + trackingBlock("garden", f.setting, f.setting.repositories[1]!) + "\n<!-- /clankie:tracking -->\n";
  const privateSource = f.privateRepo;
  const publicPath = await f.publicRepo.checkout(), privatePath = await privateSource.checkout();
  await privateSource.commitGuide(privateGuide, "Record explicit public and private destinations", privatePath);
  await f.settings.update((current) => ({ ...current, projects: ProjectsSettingsSchema.parse({ projects: [{ id: "garden", name: "Garden", workspaces: [{ id: "public", machineId: "local", platform: "posix", path: publicPath }, { id: "private", machineId: "local", platform: "posix", path: privatePath }] }] }) }));
  const initial = await f.read();
  const inferred = await f.cli("infer", "--revision", initial.revision);
  expect(inferred.decision).toBe("inferred");
  expect(inferred.selection.repositories.map((repo: any) => repo.localPath)).toEqual([publicPath, privatePath]);
  expect(inferred.selection.tracker).toEqual(f.setting.tracker);
  const before = inferred.selection;
  // Contradictory new tracker evidence is an owner decision, never a silent migration.
  await privateSource.commitGuide(privateGuide.replace("GitHub issues", "Linear issues"), "Use LIN-12 for new work", privatePath);
  const changed = await f.cli("infer", "--revision", inferred.revision);
  expect(changed.selection).toEqual(before);
  expect((await f.settings.load()).projects.projects[0]!.tracking).toEqual(before);
  expect(changed.signals.some((signal: string) => signal.includes("disagrees"))).toBe(true);
  // Configured project tracker reads do not require .clankie/tracking.json in a repo.
  const reader = createProjectWorkReader({ projects: async () => (await f.settings.load()).projects, localMachineId: "local" });
  const repos = await reader.repos();
  expect(repos[0]?.backend).toBe("github");
});

it("restricts the owner read/write projection and rejects caller-supplied write destinations", async () => {
  const f = await fixture();
  expect((await f.request(undefined, "connector-token")).status).toBe(401);
  const revision = (await f.read()).revision;
  const response = await f.request({ action: "sync", projectId: "garden", expectedRevision: revision, repository: "another/project" });
  expect(response.status).toBe(400);
  expect(f.forge.calls).toHaveLength(0);
  const read = PROJECT_TRACKING_PATH + "?projectId=garden";
  expect(hostedOperatorAllows("GET", read)).toBe(true);
  expect(publicGatewayTargetFor("GET", read)).toBe("relay");
  expect(hostedOperatorAllows("GET", read + "&repository=another/project")).toBe(false);
  expect(publicGatewayTargetFor("GET", read + "&repository=another/project")).toBeUndefined();
  expect(hostedOperatorAllows("POST", PROJECT_TRACKING_PATH, JSON.stringify({ action: "sync", projectId: "garden", expectedRevision: revision }))).toBe(true);
  expect(hostedOperatorAllows("POST", PROJECT_TRACKING_PATH, JSON.stringify({ action: "sync", projectId: "garden", expectedRevision: revision, repository: "another/project" }))).toBe(false);
});


it("sweeps changed marked bytes into one new PR and confirms the merged block again", async () => {
  const f = await fixture();
  const configured = await f.apply();
  await f.publicRepo.merge(); await f.privateRepo.merge();
  const checkout = await f.publicRepo.checkout();
  const current = await f.publicRepo.read();
  const drifted = current.replace("# Owner before", "# Owner revised before").replace("GitHub issues in `fixture/garden`", "GitHub issues in `fixture/retired`");
  await f.publicRepo.commitGuide(drifted, "Owner edits guide", checkout);
  await f.publicRepo.publishLocal(checkout);
  await f.service.sweep();
  expect(f.publicRepo.pulls.filter((pull: any) => pull.state === "open")).toHaveLength(1);
  const pending = f.publicRepo.pulls.at(-1)!;
  expect(await f.publicRepo.diff(pending.head.ref)).toBe("CLAUDE.md\n");
  const proposed = await f.publicRepo.read(pending.head.ref);
  expect(proposed).toContain("# Owner revised before");
  expect(proposed).toContain("GitHub issues in `fixture/garden`");
  expect(proposed.split("<!-- /clankie:tracking -->")[1]).toBe(drifted.split("<!-- /clankie:tracking -->")[1]);
  expect((await f.read()).selection).toEqual(configured.selection);
  await f.publicRepo.merge();
  expect((await f.cli("sync", "--revision", configured.revision)).guides.every((entry: any) => entry.state === "matches")).toBe(true);
});

it("uses Linear public/private destinations without disclosing the private board in a public guide", async () => {
  const f = await fixture();
  const selection: ProjectTracking = { ...f.setting, tracker: { backend: "linear", public: { team: "PUB", project: "public-board", board: "https://linear.app/fixture/project/public-board/overview" }, private: { team: "PRIVATE", project: "private-board", board: "https://linear.app/fixture/project/private-board/overview" } } };
  const applied = await f.apply(selection);
  expect(applied.selection.tracker).toEqual(selection.tracker);
  const publicGuide = await f.publicRepo.read(f.publicRepo.pulls[0].head.ref);
  expect(publicGuide).toContain("Linear team `PUB`");
  expect(publicGuide).not.toContain("private-board");
  const privateGuide = await f.privateRepo.read(f.privateRepo.pulls[0].head.ref);
  expect(privateGuide).toContain("Linear team `PRIVATE`");
  expect(privateGuide).toContain("private-board");
});
