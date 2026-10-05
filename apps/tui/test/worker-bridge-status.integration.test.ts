import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileCredentialStore, mintCaptainToken } from "@clankie/credential-broker";
import {
  OPERATOR_CONVERSATION_DISPATCH_PATH,
  type OperatorFleetSeat,
  type WorkerBridgeStatus,
} from "@clankie/protocol";
import { stripTerminalSequences } from "@earendil-works/pi-tui";
import { afterEach, expect, it } from "vitest";
import { doctorCommand } from "../src/command/doctor.ts";
import { formatDoctorReport } from "../src/doctor-report.ts";
import { createClankieFaceAnsiTheme } from "../src/face/clankie-face-theme.ts";
import { HerdrRoster } from "../src/observation/herdr-roster.ts";
import {
  createCaptainOperatorConversationClient,
  createCaptainRouteClient,
} from "../src/session/operator-conversations.ts";
import { LiveAgentPicker, LiveAgentStrip } from "../src/shell/live-agents.ts";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});

const observedAt = "2026-10-05T15:00:00.000Z";
const observations: readonly WorkerBridgeStatus[] = [
  { status: "not-observed", reason: "No authenticated worker tool observation." },
  {
    status: "ready",
    reason: "Authenticated catalog served; native catalog loading remains unverified.",
    observedAt,
    tools: ["clankie_tools", "clankie_call"],
  },
  { status: "pending", reason: "Catalog request is in flight.", pendingSince: observedAt },
  {
    status: "missing",
    reason: "Authenticated catalog omitted clankie_call.",
    observedAt,
    tools: ["clankie_tools"],
  },
  {
    status: "stalled",
    reason: "clankie_call exceeded its bridge observation deadline.\n\u001b[31mTry again.",
    observedAt,
    pendingSince: observedAt,
  },
];

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "clankie-worker-tools-doctor-"));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const token = mintCaptainToken();
  const seats: OperatorFleetSeat[] = observations.map((workerTools) => ({
    seatId: `pc/${workerTools.status}`,
    occupantId: workerTools.status,
    personaId: workerTools.status,
    harness: "codex",
    status: "working",
    title: workerTools.status,
    fleet: "pc",
    // Host profile/process health and catalog observations are independent.
    harnessBridge: { status: "live-process", detail: "Native host process observed" },
    workerTools,
  }));
  seats.push({
    seatId: "pc/legacy",
    occupantId: "legacy",
    personaId: "legacy",
    harness: "claude",
    status: "working",
    title: "legacy",
    fleet: "pc",
  });
  const requests: { path: string; op?: string }[] = [];
  let responseSeats: unknown = seats;
  const server: Server = createServer(async (request, response) => {
    const path = request.url!;
    const json = (status: number, body: unknown) => {
      response.writeHead(status, { "content-type": "application/json" });
      response.end(JSON.stringify(body));
    };
    if (path === "/health") return json(200, { doorway: { state: "connected" } });
    if (path === "/v1/mcp") return json(401, { error: "authentication_required" });
    if (path === OPERATOR_CONVERSATION_DISPATCH_PATH) {
      if (request.headers.authorization !== `Bearer ${token}`)
        return json(401, { error: "captain_authentication_required" });
      let body = "";
      for await (const chunk of request) body += String(chunk);
      const { op } = JSON.parse(body) as { op: string };
      requests.push({ path, op });
      if (op === "roster") return json(200, { op, schemaVersion: 1, seats: responseSeats });
      if (op === "terminal_catalog") return json(200, { op, schemaVersion: 1, sessions: [] });
      return json(400, { error: "unexpected_operation" });
    }
    requests.push({ path });
    if (request.headers.authorization !== "Bearer fixture-owner")
      return json(401, { error: "operator_authentication_required" });
    if (path === "/v1/runtime-connections") return json(200, { connections: [] });
    return json(404, { error: "not_found" });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanup.push(
    () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
        server.closeAllConnections();
      }),
  );
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing worker tools fixture address");
  const host = `http://127.0.0.1:${address.port}`;
  const options = {
    repoRoot: root,
    env: {
      HOME: join(root, "home"),
      XDG_CONFIG_HOME: join(root, "config"),
      CLANKIE_STATE: join(root, "state"),
      PATH: "",
      CLANKIE_CAPTAIN_TOKEN: token,
      CLANKIE_OPERATOR_TOKEN: "fixture-owner",
      CLANKIE_CONTROL_PLANE_URL: host,
    },
    credentialStore: new FileCredentialStore(join(root, "credentials.json")),
  };
  return {
    options,
    requests,
    seats,
    client: createCaptainOperatorConversationClient(createCaptainRouteClient({ host, captainToken: token })),
    setSeats(value: unknown) {
      responseSeats = value;
    },
  };
}

it("preserves observed missing/stalled/unknown tools through real HTTP, the public roster schema and doctor/TUI", async () => {
  const f = await fixture();
  const roster = new HerdrRoster(f.client);
  expect(await roster.poll()).toBe(true);
  const agents = roster.snapshot().liveAgents!;
  expect(agents.map(({ seat }) => seat.workerTools?.status).sort()).toEqual([
    "missing",
    "not-observed",
    "pending",
    "ready",
    "stalled",
    undefined,
  ]);
  const ansi = createClankieFaceAnsiTheme({ color: true, trueColor: true });
  const theme = {
    ansi,
    selectListTheme: {
      description: ansi.dim,
      noMatch: ansi.dim,
      scrollInfo: ansi.dim,
      selectedPrefix: ansi.cyan,
      selectedText: ansi.bold,
    },
  };
  const strip = new LiveAgentStrip(() => agents, theme);
  expect(strip.focus()).toBe(true);
  expect(strip.selected()?.seat.workerTools?.status).toBe("missing");
  const plain = (rows: string[]) => rows.map(stripTerminalSequences).join("\n");
  const dock = plain(strip.render(220));
  for (const status of ["missing", "stalled", "unknown", "pending", "catalog served"])
    expect(dock).toContain(`tools ${status}`);
  strip.select("pc/stalled");
  const picker = new LiveAgentPicker(() => agents, strip, theme, {
    maxHeight: () => 24,
    onOpen() {},
    onClose() {},
    onRender() {},
  });
  const detail = plain(picker.render(180));
  expect(detail).toContain("Worker tools: clankie_call exceeded its bridge observation deadline. Try again.");
  expect(detail).not.toContain("\u001b[31m");
  const report = await doctorCommand(f.options);
  expect(report.workerTools?.workers.map(({ status }) => status)).toEqual([
    ...observations.map(({ status }) => status),
    "not-observed",
  ]);
  expect(report.workerTools?.workers[3]).toMatchObject({ tools: ["clankie_tools"], status: "missing" });
  const human = formatDoctorReport(report);
  expect(human).toContain(
    "✗ Worker pc/missing tools · missing · Authenticated catalog omitted clankie_call.",
  );
  expect(human).toContain(
    "✗ Worker pc/stalled tools · stalled · clankie_call exceeded its bridge observation deadline. Try again.",
  );
  expect(human).toContain("○ Worker pc/not-observed tools · unknown");
  expect(human).toContain("○ Worker pc/legacy tools · unknown");
  expect(human).toContain("✓ Worker pc/ready tools · catalog served");
  expect(human).not.toContain("\u001b");
  expect(f.requests.filter(({ op }) => op === "roster")).toHaveLength(2);
});

it("reports unknown rather than healthy when the roster contract or observation credential is unavailable", async () => {
  const f = await fixture();
  f.setSeats([
    { ...f.seats[0]!, workerTools: { status: "healthy", reason: "An unsupported inferred status" } },
  ]);
  const report = await doctorCommand(f.options);
  expect(report.workerTools).toMatchObject({
    workers: [],
    error: "Clankie conversation response failed schema validation",
  });
  expect(formatDoctorReport(report)).toContain(
    "○ Worker tools · unknown · Clankie conversation response failed schema validation",
  );
  const requests = f.requests.length;
  const { CLANKIE_CAPTAIN_TOKEN: _token, ...env } = f.options.env;
  const unavailable = await doctorCommand({ ...f.options, env });
  expect(unavailable.workerTools).toEqual({
    workers: [],
    error: "Worker tool observations need the captain credential",
  });
  expect(f.requests.slice(requests).some(({ op }) => op === "roster")).toBe(false);
});
