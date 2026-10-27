import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileCredentialStore } from "@clankie/credential-broker";
import { afterEach, expect, it } from "vitest";
import { doctorCommand, machineDoctorCommand, formatDoctorSummary } from "../src/command/doctor.ts";
import { formatDoctorReport } from "../src/doctor-report.ts";

const roots: string[] = [];
const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(
    servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
  );
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

it.each(["healthy", "unavailable"] as const)(
  "keeps a live bridge headline beside historical refusal and reports the down fleet link when the harness probe is %s",
  async (harnessStatus) => {
    const root = await mkdtemp(join(tmpdir(), "clankie-doctor-fleet-link-"));
    roots.push(root);
    const reason = "Get-Command : The term 'herdr' is not recognized as the name of a cmdlet.";
    const linkState = { state: "unreachable", since: "2026-10-04T12:00:00.000Z", error: reason };
    const harnesses = { codex: { registered: true }, claude: [{ profile: "remote", versionMatches: true }] };
    const requests: string[] = [];
    let updateStatus: unknown = {};
    const server = createServer((request, response) => {
      const path = request.url!;
      requests.push(path);
      const json = (status: number, body: unknown) => {
        response.writeHead(status, { "content-type": "application/json" });
        response.end(JSON.stringify(body));
      };
      if (path === "/health") return json(200, { doorway: { state: "connected" } });
      if (path === "/v1/mcp") return json(401, { error: "authentication_required" });
      if (request.headers.authorization !== "Bearer doctor-owner")
        return json(401, { error: "operator_authentication_required" });
      if (path === "/v1/runtime-update") return json(200, updateStatus);
      if (path === "/operator/v1/dispatch") {
        let body = "";
        request.on("data", (chunk) => (body += chunk));
        request.on("end", () => {
          const { op } = JSON.parse(body);
          if (op === "seat_bridges")
            return json(200, {
              op,
              schemaVersion: 1,
              bridges: [
                {
                  conversationId: "conv-kh2",
                  state: "disconnected",
                  eventKinds: ["wake"],
                  ownerOrigin: false,
                  detail: "KH2: Seat bridge is disconnected; the native channel has not returned.",
                },
              ],
            });
          json(404, { error: "not_found" });
        });
        return;
      }
      if (path === "/v1/captain/seat-bindings")
        return json(200, {
          available: true,
          bindings: [],
          lastRefusal: {
            error: "seat_bridge_claim_invalid",
            recovery: "Relaunch to recreate the private MCP configuration.",
          },
        });
      if (path === "/v1/runtime-connections")
        return json(200, {
          connections: [
            { id: "default", machine: "local", state: "disabled", enabled: false },
            {
              id: "pc",
              machine: "personal-pc",
              kind: "herdr",
              session: "main",
              ssh: { host: "fixture-pc", shell: "powershell" },
              transport: "ssh",
              state: "healthy",
              enabled: true,
              linkState,
            },
          ],
        });
      if (path === "/v1/runtime-connections/pc/harnesses")
        return harnessStatus === "healthy"
          ? json(200, { machine: "pc", harnesses })
          : json(503, { error: "harness_inspection_unavailable", detail: "Remote inspection unavailable" });
      if (path === "/v1/runtime-connections/pc/membership") return json(200, { machine: "pc", panes: [] });
      return json(404, { error: "not_found" });
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Missing doctor fixture address");
    // The real fetch and executable probes run against isolated local state.
    // An empty PATH keeps unrelated installed harnesses outside this boundary.
    const env = {
      HOME: join(root, "home"),
      XDG_CONFIG_HOME: join(root, "config"),
      CLANKIE_STATE: join(root, "state"),
      PATH: "",
      CLANKIE_OPERATOR_TOKEN: "doctor-owner",
      CLANKIE_CAPTAIN_TOKEN: "doctor-owner",
      CLANKIE_CONTROL_PLANE_URL: `http://127.0.0.1:${address.port}`,
    };
    const report = await doctorCommand({
      repoRoot: root,
      env,
      credentialStore: new FileCredentialStore(join(root, "credentials.json")),
    });
    expect(report.remoteHarnesses).toHaveLength(1);
    const updateReports = [];
    for (const [phase, mode, pending, reason, expected] of [
      ["installing", "enforce", "update-1", undefined, true],
      ["restarting", "enforce", "update-1", undefined, true],
      ["refused", "enforce", undefined, "operator-seats-unready", true],
      ["installing", "observe", "update-1", undefined, false],
      ["installing", undefined, "update-1", undefined, false],
      ["installing", "enforce", "other-update", undefined, false],
      ["healthy", "enforce", "update-1", undefined, false],
      ["rolled-back", "enforce", undefined, undefined, false],
      ["refused", "enforce", undefined, "current-release-changed", false],
    ] as const) {
      updateStatus = { pending, latest: { id: "update-1", phase, reason, operatorSeatBindingMode: mode } };
      const updateReport = await doctorCommand({
        repoRoot: root,
        env,
        credentialStore: new FileCredentialStore(join(root, "credentials.json")),
      });
      expect(updateReport.pendingEnforcingUpdate).toBe(expected);
      updateReports.push(updateReport);
    }
    for (const complete of [false, true]) {
      const observed = {
        ...report,
        operatorSeatBindings: {
          available: true,
          mode: "observe" as const,
          bindings: [],
          inventory: {
            complete,
            ready: false,
            seats: [
              {
                pid: 42,
                startTime: "1",
                command: "claude",
                conversationId: "legacy",
                sessionId: null,
                bound: false,
                processes: [],
              },
            ],
          },
        },
      };
      const voice = {
        state: "refused" as const,
        provider: "openai" as const,
        checkedProvider: "openai" as const,
        scope: "transcription" as const,
        checkedAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 60000).toISOString(),
        cached: true,
      };
      const withVoice = { ...observed, voice: { ...observed.voice!, providerReadiness: voice } };
      const summary = formatDoctorSummary(withVoice);
      expect(summary.split("\n")[0]).toContain("Voice provider openai refused");
      expect(summary).toContain("Observe mode:");
      expect(summary).toContain("UNBOUND launcher unregistered");
      const { mode: _mode, ...unknownMode } = observed.operatorSeatBindings;
      const unknownSummary = formatDoctorSummary({ ...withVoice, operatorSeatBindings: unknownMode });
      expect(unknownSummary.split("\n")[0]).toContain("Voice provider openai refused");
      expect(unknownSummary).toContain("Seat binding diagnostics:");
      const enforcing = formatDoctorSummary({
        ...withVoice,
        operatorSeatBindings: { ...observed.operatorSeatBindings, mode: "enforce" },
      });
      expect(enforcing.split("\n")[0]).toContain(complete ? "is unbound" : "inventory is unavailable");
      for (const updateReport of updateReports) {
        const pendingSummary = formatDoctorSummary({
          ...updateReport,
          voice: withVoice.voice,
          operatorSeatBindings: observed.operatorSeatBindings,
        });
        expect(pendingSummary.split("\n")[0]).toContain(
          updateReport.pendingEnforcingUpdate
            ? complete
              ? "is unbound"
              : "inventory is unavailable"
            : "Voice provider openai refused",
        );
      }
    }
    expect(formatDoctorReport(report)).toContain("✗ Seat bridge conv-kh2 · disconnected · KH2:");
    expect(report.operatorSeatBindings).toMatchObject({
      available: true,
      lastRefusal: { error: "seat_bridge_claim_invalid" },
    });
    // Historical binding evidence stays in the body while the live bridge fault
    // retains the actionable headline. Both are present in this same report.
    expect(formatDoctorSummary(report)).toContain("Seat bridge disconnected for conv-kh2. KH2:");
    expect(formatDoctorReport(report)).toContain("Last native seat refusal · seat_bridge_claim_invalid");
    expect(
      formatDoctorSummary({
        ...report,
        operatorSeatBindings: {
          available: false,
          mode: "enforce",
          error: "seat_binding_helper_missing",
          recovery: "Prepare native helper; relaunch.",
          bindings: [],
        },
      }),
    ).toContain("seat_binding_helper_missing: Prepare native helper");
    expect(report.remoteHarnesses?.[0]).toMatchObject({ machine: "pc", linkState });
    expect(formatDoctorReport(report)).toContain(`✗ Fleet pc · unreachable · ${reason}`);
    const machine = await machineDoctorCommand("pc", { env });
    expect(machine).toMatchObject({ machine: "pc", linkState, membership: { machine: "pc", panes: [] } });
    if (harnessStatus === "healthy") {
      expect(report.remoteHarnesses?.[0]).toMatchObject({ harnesses });
      expect(machine.harnesses).toEqual(harnesses);
    } else {
      expect(report.remoteHarnesses?.[0]).toMatchObject({
        status: "unavailable",
        detail: "Remote inspection unavailable",
      });
      expect(machine.harnesses).toEqual({ status: "unavailable", detail: "Remote inspection unavailable" });
    }
    expect(requests.filter((path) => path === "/v1/runtime-connections")).toHaveLength(
      2 + updateReports.length,
    );
    expect(requests.filter((path) => path === "/v1/runtime-connections/pc/harnesses")).toHaveLength(
      2 + updateReports.length,
    );
    expect(requests).not.toContain("/v1/runtime-connections/default/harnesses");
    expect(JSON.stringify(report.remoteHarnesses)).not.toContain("CLIXML");
  },
);
