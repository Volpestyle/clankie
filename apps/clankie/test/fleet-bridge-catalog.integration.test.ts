import { execFile } from "node:child_process";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { FileCredentialStore } from "@clankie/credential-broker";
import { SettingsStore } from "@clankie/settings";
import { afterEach, expect, it } from "vitest";
import { inspectFleetHarnesses, workerPluginDir } from "../src/fleet-prepare.ts";
import type { HerdrFleet } from "../src/herdr-fleet.ts";
import { linearMcp } from "../src/linear-mcp.ts";
import { createMcpHost } from "../src/mcp-host.ts";
import { WorkerMcp } from "../src/worker-mcp.ts";

// #379: a machine's own worker plugin copy can lack a tool the service serves
// without its version changing. Inspection runs that copy's real inspector over
// the real posix fleet command and compares it with the service's real catalog.
const repoRoot = join(import.meta.dirname, "..", "..", "..");
const fleet: HerdrFleet = { id: "studio", session: "default", ssh: { host: "me@studio", shell: "posix" } };
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function inspect(prepareCopy: (worker: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "clankie-bridge-catalog-"));
  roots.push(root);
  const home = join(root, "home");
  const worker = join(home, ".clankie", "claude-plugin", "worker");
  await cp(workerPluginDir(repoRoot), worker, { recursive: true });
  await prepareCopy(worker);
  const settings = new SettingsStore(join(root, "settings.json"));
  await settings.update((current) => ({
    ...current,
    fleet: { ...current.fleet, tools: "connected", peerMessages: "on" },
  }));
  const credentials = new FileCredentialStore(join(root, "credentials.json"));
  const service = new WorkerMcp({
    directory: join(root, "grants"),
    credentials,
    host: createMcpHost({
      trackerMcp: linearMcp,
      credentials,
      settings,
      curated: [],
      logger: { info() {}, warn() {} },
    }),
    fleetTools: async () => (await settings.load()).fleet.tools,
    fleetPeerMessages: async () => (await settings.load()).fleet.peerMessages,
  });
  // The remote account: its own home, Node only, no Claude or Codex executable.
  const shell = (command: string) =>
    new Promise<string>((resolve, reject) =>
      execFile(
        "/bin/sh",
        ["-c", command],
        { env: { HOME: home, PATH: `${dirname(process.execPath)}:/usr/bin:/bin` }, timeout: 60_000 },
        (error, stdout, stderr) =>
          error ? reject(new Error(`${error.message}\n${stderr}`)) : resolve(stdout),
      ),
    );
  try {
    return {
      expected: await service.expectedBridgeToolNames(),
      report: (await inspectFleetHarnesses(fleet, {
        shell,
        workerPluginDir: workerPluginDir(repoRoot),
        expectedBridgeTools: () => service.expectedBridgeToolNames(),
      })) as {
        catalog: {
          expected: string[];
          claude: { reported: boolean; missing: string[] };
          codex: unknown;
          refreshNeeded: boolean;
          reason?: string;
        };
      },
    };
  } finally {
    await service.close();
  }
}

it("passes a machine whose worker bridge defines every served tool", async () => {
  const { expected, report } = await inspect(async () => {});
  expect(expected).toEqual(
    expect.arrayContaining(["message_clankie", "message_peer", "submit_for_review", "evidence_push"]),
  );
  expect(expected).not.toContain("clankie_call");
  expect(report.catalog).toEqual({
    expected,
    claude: { reported: true, missing: [] },
    codex: null,
    refreshNeeded: false,
  });
});

it("reports a machine whose worker bridge lacks review-tools.mjs as needing a refresh, naming the tools", async () => {
  const { REVIEW_TOOLS } = await import("../../../integrations/claude-plugin/worker/bin/review-tools.mjs");
  const review = REVIEW_TOOLS.map((tool) => tool.name).sort();
  const { report } = await inspect((worker) => rm(join(worker, "bin", "review-tools.mjs")));
  expect(report.catalog.refreshNeeded).toBe(true);
  expect(report.catalog.claude).toEqual({ reported: true, missing: review });
  expect(report.catalog.reason).toBe(
    `Claude's worker bridge lacks ${review.join(", ")} on studio; hires there fail until \`clankie herdr prepare studio\` refreshes it.`,
  );
});

it("reports a copy that predates tool reporting as needing a refresh", async () => {
  // The inspector every copy shipped before #379.
  const { report } = await inspect((worker) =>
    writeFile(
      join(worker, "bin", "harness-inspect.mjs"),
      'import { inspectHarnessProfiles } from "./harness-status.mjs";\n' +
        "process.stdout.write(`${JSON.stringify(await inspectHarnessProfiles({ expectedVersion: process.argv[2] }))}\\n`);\n",
    ),
  );
  expect(report.catalog.claude).toEqual({ reported: false, missing: [] });
  expect(report.catalog.refreshNeeded).toBe(true);
  expect(report.catalog.reason).toMatch(/^Claude's worker bridge predates tool reporting on studio;/u);
});

it("names only list_report_leads when a cached seat-tools module predates that tool", async () => {
  const { report } = await inspect(async (worker) => {
    const path = join(worker, "bin", "seat-tools.mjs");
    const source = await readFile(path, "utf8");
    const start = source.indexOf("\nexport const REPORT_LEADS_TOOL = {");
    expect(start).toBeGreaterThan(0);
    await writeFile(path, source.slice(0, start));
  });
  expect(report.catalog.refreshNeeded).toBe(true);
  expect(report.catalog.claude).toEqual({ reported: true, missing: ["list_report_leads"] });
  expect(report.catalog.reason).toBe(
    "Claude's worker bridge lacks list_report_leads on studio; hires there fail until `clankie herdr prepare studio` refreshes it.",
  );
});
