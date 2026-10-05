import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import {
  FileCredentialStore,
  mintOperatorToken,
  OPERATOR_CREDENTIAL_PROVIDER_ID,
} from "@clankie/credential-broker";
import { ProjectsSettingsSchema } from "@clankie/protocol/projects";
import { SettingsStore } from "@clankie/settings";
import { createFleetSettingsRoutes } from "../../clankie/src/fleet-settings-routes.ts";
import { createProjectRoutes } from "../../clankie/src/project-routes.ts";
import { runFleetCommand } from "../src/command/fleet.ts";
import { runHarnessCommand } from "../src/command/harness.ts";
import { runProjectSettingsCommand } from "../src/command/project-settings.ts";
import { herdrFleetRuntimeArgs } from "../src/command/herdr.ts";
import { runRuntimeCommand } from "../src/command/runtime.ts";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "fleet-autonomy-cli-")));
  roots.push(root);
  const settings = new SettingsStore(join(root, "settings.json"));
  const credentials = new FileCredentialStore(join(root, "credentials.json"));
  const token = mintOperatorToken();
  await credentials.set(OPERATOR_CREDENTIAL_PROVIDER_ID, { type: "api", key: token });
  await settings.update((current) => ({
    ...current,
    projects: ProjectsSettingsSchema.parse({
      projects: [
        {
          id: "garden",
          name: "Garden",
          workerCap: 2,
          roles: [{ role: "builder", harness: "codex" }],
          workspaces: [{ id: "primary", machineId: "local", platform: "posix", path: root }],
        },
      ],
    }),
  }));
  const authorize = async (request: Request) =>
    request.headers.get("authorization") === `Bearer ${token}`
      ? (true as const)
      : ("authentication_required" as const);
  let linked = true;
  const fleetRoutes = createFleetSettingsRoutes(authorize, settings, {
    herdrBinding: () =>
      linked ? { runtime: "external", session: "fixture", socketPath: join(root, "herdr.sock") } : undefined,
  });
  const projectRoutes = createProjectRoutes(authorize, settings);
  const writes: unknown[] = [];
  const client = {
    env: { HOME: root, CLANKIE_OPERATOR_TOKEN: token },
    operatorCredentialStore: credentials,
    host: "http://clankie.test",
    cwd: root,
    fetchImpl: (async (url: RequestInfo | URL, init?: RequestInit) => {
      const target = new URL(String(url));
      if (target.pathname.endsWith("/prepare")) {
        writes.push(JSON.parse(init!.body as string));
        return Response.json({ ok: true });
      }
      return (target.pathname.includes("fleet-settings") ? fleetRoutes : projectRoutes).request(
        target.pathname + target.search,
        init,
      );
    }) as typeof fetch,
  };
  return {
    root,
    settings,
    client,
    writes,
    unlink: () => {
      linked = false;
    },
  };
}

it("persists logical fleet autonomy leaves independently and clear restores lead defaults", async () => {
  const f = await fixture();
  await runFleetCommand(["set", "--closure", "owner", "--size", "small"], { settings: f.settings });
  const saved = await runFleetCommand(["set", "--machine-setup", "owner"], { settings: f.settings });
  expect(saved.fleet).toMatchObject({ closure: "owner", machineSetup: "owner", size: "small" });
  expect((await f.settings.load()).autonomy.fleet).toEqual({ closure: "owner", machineSetup: "owner" });
  expect((await f.settings.load()).fleet).not.toHaveProperty("closure");
  await expect(runFleetCommand(["set", "--closure", "ask"], { settings: f.settings })).rejects.toThrow(
    "lead or owner",
  );
  const clear = await runFleetCommand(["clear"], { settings: f.settings });
  expect(clear.fleet).toMatchObject({ closure: "lead", machineSetup: "lead", size: "max" });
  expect((await f.settings.load()).projects.projects[0]!.workerCap).toBe(2);
});

it("edits and clears project leaves through the real revision API while reporting stored and effective values", async () => {
  const f = await fixture();
  await runFleetCommand(["set", "--closure", "owner"], { settings: f.settings });
  const result = await runProjectSettingsCommand(
    ["settings", "garden", "--machine-setup", "owner"],
    f.client,
  );
  expect(result).toMatchObject({
    fleet: {
      closure: "inherit",
      machineSetup: "owner",
      effective: { closure: "owner", machineSetup: "owner" },
    },
  });
  const inherited = await runProjectSettingsCommand(
    ["settings", "garden", "--machine-setup", "inherit", "--closure", "lead"],
    f.client,
  );
  expect(inherited).toMatchObject({
    fleet: { closure: "lead", machineSetup: "inherit", effective: { closure: "lead", machineSetup: "lead" } },
  });
  expect((await f.settings.load()).projects.projects[0]).toMatchObject({
    workerCap: 2,
    roles: [{ role: "builder", harness: "codex" }],
    autonomy: { fleet: { closure: "lead" } },
  });
});

async function nativeFixture() {
  const f = await fixture();
  const selected = join(f.root, ".claude-selected");
  const sibling = join(f.root, ".claude-other");
  const codex = join(f.root, ".codex");
  await Promise.all([selected, sibling, codex].map((path) => mkdir(path)));
  const source = join(f.root, "codex-source.toml");
  await writeFile(source, "# generated by owner setup\nmodel = 'owner-model'\n");
  await symlink(source, join(codex, "config.toml"));
  const calls: Array<{ command: string; args: readonly string[]; profile?: string }> = [];
  const sourceSetup = join(f.root, "own-setup.py");
  const options = {
    ...f.client,
    repoRoot: f.root,
    env: { ...f.client.env, CLAUDE_CONFIG_DIR: selected, CODEX_HOME: codex },
    prepareSkills: async () => {},
    execute: async (command: string, args: readonly string[], env?: NodeJS.ProcessEnv) => {
      calls.push({ command, args, ...(env?.CLAUDE_CONFIG_DIR ? { profile: env.CLAUDE_CONFIG_DIR } : {}) });
      if (command === "python3")
        await writeFile(source, "# generated by owner setup\nmodel = 'owner-model'\n# plugin installed\n");
    },
  };
  return { ...f, selected, sibling, codex, source, sourceSetup, calls, options };
}

it("lead setup runs headlessly on the linked machine, prepares its own source-managed Codex profile and skips sibling Claude accounts", async () => {
  const f = await nativeFixture();
  const results = await runHarnessCommand(["install", "--codex-source-setup", f.sourceSetup], f.options);
  if (!Array.isArray(results)) throw new Error("Expected install profile receipts");
  expect(results.find((entry) => entry.harness === "codex")).toMatchObject({
    status: "source-setup-completed",
  });
  expect(results.find((entry) => entry.profile === f.selected)).toMatchObject({ status: "installed" });
  expect(results.find((entry) => entry.profile === f.sibling)).toMatchObject({ status: "declined" });
  expect(
    f.calls.filter((call) => call.profile === f.sibling).every((call) => call.args[0] === "--version"),
  ).toBe(true);
  expect(f.calls).toContainEqual({ command: "python3", args: [f.sourceSetup], profile: f.selected });
  expect(await realpath(join(f.codex, "config.toml"))).toBe(f.source);
  expect(await readFile(f.source, "utf8")).toContain("owner-model");
});

it("owner project overrides and unlinked machines stop automatic setup, while explicit owner approval permits the selected profile", async () => {
  const f = await nativeFixture();
  await runProjectSettingsCommand(["settings", "garden", "--machine-setup", "owner"], f.client);
  await expect(runHarnessCommand(["install"], f.options)).rejects.toThrow("owner approval");
  expect(f.calls).toEqual([]);
  await expect(runHarnessCommand(["install", "--project", "another"], f.options)).rejects.toThrow(
    "context refused",
  );
  expect(f.calls).toEqual([]);
  const accepted = await runHarnessCommand(
    ["install", "--approve", "--codex-source-setup", f.sourceSetup],
    f.options,
  );
  if (!Array.isArray(accepted)) throw new Error("Expected install profile receipts");
  expect(accepted.find((entry) => entry.harness === "codex")).toMatchObject({
    status: "source-setup-completed",
  });
  await runProjectSettingsCommand(["settings", "garden", "--machine-setup", "inherit"], f.client);
  f.unlink();
  await expect(runHarnessCommand(["install"], f.options)).rejects.toThrow("already-linked");
});

it("remote prepare includes current canonical project context and requires explicit approval under an owner override", async () => {
  const f = await fixture();
  await runProjectSettingsCommand(["settings", "garden", "--machine-setup", "owner"], f.client);
  await expect(runRuntimeCommand(["prepare", "local"], f.client)).rejects.toThrow("owner approval");
  expect(f.writes).toEqual([]);
  const args = [
    "prepare",
    "local",
    "--project",
    "garden",
    "--approve",
    "--codex-source-setup",
    "/owner/source.py",
  ];
  expect(herdrFleetRuntimeArgs(args)).toEqual(args);
  await runRuntimeCommand(args, f.client);
  expect(f.writes).toEqual([
    {
      workingDirectory: f.root,
      projectId: "garden",
      ownerApproved: true,
      codexSourceSetup: "/owner/source.py",
    },
  ]);
  expect(() => herdrFleetRuntimeArgs([...args, "--approve"])).toThrow("Usage");
});

it("applies current owner and existing-link policy to refresh-linked without accepting source or duplicate flags", async () => {
  const f = await nativeFixture();
  const options = { ...f.options, settings: f.settings };
  for (const args of [
    ["install", "--refresh-linked", "--refresh-linked"],
    ["install", "--refresh-linked", "--approve", "--approve"],
    ["install", "--refresh-linked", "--codex-source-setup", f.sourceSetup],
  ])
    await expect(
      runHarnessCommand(args, {
        ...options,
        fetchImpl: async () => {
          throw new Error("Malformed flags must be refused before reading or dispatching setup");
        },
      }),
    ).rejects.toThrow("Usage");
  await runProjectSettingsCommand(["settings", "garden", "--machine-setup", "owner"], f.client);
  await expect(runHarnessCommand(["install", "--refresh-linked"], options)).rejects.toThrow("--approve");
  await expect(
    runHarnessCommand(["install", "--refresh-linked", "--approve", "--project", "another"], options),
  ).rejects.toThrow("context refused");
  expect(f.calls).toEqual([]);
  await writeFile(f.source, '# generated by owner setup\n[mcp_servers.clankie]\ncommand = "old"\n');
  const approved = await runHarnessCommand(
    ["install", "--refresh-linked", "--project", "garden", "--approve"],
    options,
  );
  if (Array.isArray(approved)) throw new Error("Expected refresh receipts");
  expect(approved.local).toEqual([
    expect.objectContaining({ harness: "codex", profile: f.codex, status: "source-manager-required" }),
  ]);
  expect(approved.ok).toBe(false);
  expect(approved.notices.state).toBe("deferred");
  expect(f.calls.every((call) => call.args[0] === "--version" || call.args[1] === "list")).toBe(true);
  await runProjectSettingsCommand(["settings", "garden", "--machine-setup", "inherit"], f.client);
  f.unlink();
  const before = f.calls.length;
  await expect(runHarnessCommand(["install", "--refresh-linked"], options)).rejects.toThrow("already-linked");
  expect(f.calls).toHaveLength(before);
});

it("keeps refresh source receipts tied to the exact approved Codex source and skips unlinked sibling profiles", async () => {
  const f = await nativeFixture();
  await runHarnessCommand(["install", "--codex-source-setup", f.sourceSetup], f.options);
  const receiptPath = join(f.codex, "plugins", "clankie-source-setup.json");
  const receipt = await readFile(receiptPath, "utf8");
  expect(JSON.parse(receipt)).toMatchObject({ source: f.source, command: "python3", args: [f.sourceSetup] });
  f.calls.splice(0);
  const result = await runHarnessCommand(["install", "--refresh-linked"], {
    ...f.options,
    settings: f.settings,
  });
  if (Array.isArray(result)) throw new Error("Expected refresh receipts");
  // The source hook is reused, but this fixture deliberately has no native
  // plugin cache/version proof; the coordinator must retain the failed receipt.
  expect(f.calls.filter((call) => call.command === "python3")).toHaveLength(1);
  expect(result.local).toContainEqual(
    expect.objectContaining({ harness: "codex", profile: f.codex, status: "failed" }),
  );
  expect(result.ok).toBe(false);
  expect(result.local.some((entry) => entry.profile === f.sibling)).toBe(false);
  expect(await realpath(join(f.codex, "config.toml"))).toBe(f.source);
  expect(await readFile(receiptPath, "utf8")).toBe(receipt);
  const changedSource = join(f.root, "changed-codex-source.toml");
  await writeFile(changedSource, '# generated by another source\n[mcp_servers.clankie]\ncommand = "old"\n');
  await rm(join(f.codex, "config.toml"));
  await symlink(changedSource, join(f.codex, "config.toml"));
  f.calls.splice(0);
  const changed = await runHarnessCommand(["install", "--refresh-linked"], {
    ...f.options,
    settings: f.settings,
  });
  if (Array.isArray(changed)) throw new Error("Expected refresh receipts");
  expect(changed.local).toContainEqual(
    expect.objectContaining({ harness: "codex", profile: f.codex, status: "source-manager-required" }),
  );
  expect(f.calls.some((call) => call.command === "python3")).toBe(false);
  expect(await readFile(receiptPath, "utf8")).toBe(receipt);
});

it("rechecks machine setup policy at each linked-profile consent before native mutation", async () => {
  const f = await nativeFixture();
  await mkdir(join(f.selected, "plugins"));
  await writeFile(
    join(f.selected, "plugins", "known_marketplaces.json"),
    JSON.stringify({ clankie: { source: { source: "directory", path: f.root } } }),
  );
  let reads = 0;
  await expect(
    runHarnessCommand(["install", "--refresh-linked"], {
      ...f.options,
      settings: f.settings,
      fetchImpl: async (input, init) => {
        if (new URL(String(input)).pathname.endsWith("fleet-settings/context") && ++reads === 4)
          await f.settings.update((current) => ({
            ...current,
            autonomy: { fleet: { ...current.autonomy.fleet, machineSetup: "owner" } },
          }));
        return f.client.fetchImpl(input, init);
      },
    }),
  ).rejects.toThrow("--approve");
  expect(reads).toBe(4);
  expect(f.calls).toHaveLength(1);
  expect(f.calls[0]!.args).toEqual(["--version"]);
});

it("refuses a captured SSH destination when its registered fleet ID is rebound during the current policy read", async () => {
  const f = await nativeFixture();
  await f.settings.update((current) => ({
    ...current,
    machines: [{ id: "pc", ssh: "fixture-pc", shell: "posix", aliases: [] }],
    execution: {
      ...current.execution,
      connections: [
        {
          id: "pc",
          machine: "pc",
          kind: "herdr",
          session: "fixture-session",
          ssh: { host: "fixture-original", shell: "posix" },
          capabilities: ["code"],
          enabled: true,
        },
      ],
    },
  }));
  let rebound = false;
  const result = await runHarnessCommand(["install", "--refresh-linked", "--approve"], {
    ...f.options,
    settings: f.settings,
    fetchImpl: async (input, init) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith("fleet-settings/context") && url.searchParams.get("machine") === "pc") {
        rebound = true;
        await f.settings.update((current) => ({
          ...current,
          execution: {
            ...current.execution,
            connections: current.execution.connections.map((entry) => ({
              ...entry,
              ssh: { host: "fixture-rebound", shell: "posix" },
            })),
          },
        }));
      }
      return f.client.fetchImpl(input, init);
    },
  });
  if (Array.isArray(result)) throw new Error("Expected refresh receipts");
  expect(rebound).toBe(true);
  expect(result.fleets).toEqual([
    {
      fleet: "pc",
      ok: false,
      error: "The linked setup destination changed; inspect its connection before proceeding.",
    },
  ]);
  expect(result.ok).toBe(false);
});
