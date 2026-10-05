import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileCredentialStore } from "@clankie/credential-broker";
import { afterEach, expect, it } from "vitest";
import { doctorCommand, machineDoctorCommand } from "../src/command/doctor.ts";
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
  "shows the service's down fleet link and real reason when the harness probe is %s",
  async (harnessStatus) => {
    const root = await mkdtemp(join(tmpdir(), "clankie-doctor-fleet-link-"));
    roots.push(root);
    const reason = "Get-Command : The term 'herdr' is not recognized as the name of a cmdlet.";
    const linkState = { state: "unreachable", since: "2026-10-04T12:00:00.000Z", error: reason };
    const harnesses = { codex: { registered: true }, claude: [{ profile: "remote", versionMatches: true }] };
    const requests: string[] = [];
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
      CLANKIE_CONTROL_PLANE_URL: `http://127.0.0.1:${address.port}`,
    };
    const report = await doctorCommand({
      repoRoot: root,
      env,
      credentialStore: new FileCredentialStore(join(root, "credentials.json")),
    });
    expect(report.remoteHarnesses).toHaveLength(1);
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
    expect(requests.filter((path) => path === "/v1/runtime-connections")).toHaveLength(2);
    expect(requests.filter((path) => path === "/v1/runtime-connections/pc/harnesses")).toHaveLength(2);
    expect(requests).not.toContain("/v1/runtime-connections/default/harnesses");
    expect(JSON.stringify(report.remoteHarnesses)).not.toContain("CLIXML");
  },
);
