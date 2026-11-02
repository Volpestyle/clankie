import { ConversationStore } from "../../src/captain/conversations.ts";
import { InboundSeatReceipts } from "../../src/captain/inbound-seat-receipts.ts";
import { occupantIdForHerdrSession } from "../../src/captain/herdr-census.ts";
import { randomUUID } from "node:crypto";
import { deliveryFingerprint } from "../../src/captain/delivery-fence.ts";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ProjectsSettingsSchema } from "@clankie/protocol/projects";
import { SettingsStore } from "@clankie/settings";
import { createCaptain } from "../../src/captain/captain.ts";
import type { CaptainDeps } from "../../src/captain/deps.ts";
import { createCodexSeatAdapter } from "../../src/captain/codex-seat-adapter.ts";
import { vi } from "vitest";
import { HerdrWatchStore, parseHerdrAgentResult } from "../../src/captain/herdr-watch.ts";
import type { LeadWakes } from "../../src/lead-wakes.ts";
import { codex0160Protocol } from "./codex-0160-protocol.ts";

/** Real captain and native Codex transport; only Herdr's inventory and the external harness are fixtures. */
export async function reportWakeCaptain(root: string, leadWakes: LeadWakes) {
  const native = await codex0160Protocol(root);
  const pane = {
    pane_id: "w1:p1",
    terminal_id: "term_report",
    name: "report-worker",
    agent: "codex",
    agent_status: "working",
    cwd: root,
    agent_session: { source: "herdr:codex", kind: "path", value: native.rolloutPath },
  };
  const snapshot = () => parseHerdrAgentResult(JSON.stringify({ result: { agent: pane } }));
  const adapter = createCodexSeatAdapter({
    server: native.launch,
    trackerOverrides: async () => [],
    herdr: async (args) => {
      if (args[1] === "report-agent") pane.agent_status = args[args.indexOf("--state") + 1]!;
    },
  });
  const settings = new SettingsStore(join(root, "settings.json"));
  await settings.update((current) => ({
    ...current,
    projects: ProjectsSettingsSchema.parse({
      ...current.projects,
      projects: [
        {
          id: "proof",
          name: "Proof",
          workspaces: [{ id: "local", machineId: "local", platform: "posix", path: root }],
        },
      ],
    }),
  }));
  await writeFile(join(root, "lead.json"), JSON.stringify({ schemaVersion: 1, lead: "apps" }));
  // Usage/sign-in observation is an external boundary, supplied without touching an account.
  const spawn = HerdrWatchStore.prototype.spawnSeat;
  const usage = vi.spyOn(HerdrWatchStore.prototype, "spawnSeat").mockImplementation(function (
    this: HerdrWatchStore,
    ...args
  ) {
    this.workerAccountsReport = async () => ({
      machine: "local",
      shell: "posix",
      observedAt: new Date().toISOString(),
      accounts: [
        {
          harness: "codex",
          label: "protocol-fixture",
          home: root,
          signedIn: true,
          usable: true,
          plan: "pro",
          headroom: 0.8,
          usage: {
            source: "codex-rate-limits",
            observedAt: new Date().toISOString(),
            windows: [{ id: "week", label: "Week", usedPercent: 20 }],
          },
        },
      ],
    });
    return spawn.apply(this, args);
  });
  // An existing unread report belongs to a different worker; targeted ACK must leave it alone.
  const seeded = new ConversationStore(join(root, "conversations"), async () => {});
  new InboundSeatReceipts(join(root, "seed-receipts.json"), seeded).accept(
    "another-pane",
    { id: randomUUID(), binding: "another-binding" },
    "Another lead's unread report",
    "Another lead's unread report",
    "global-default",
    async (_id, _text, _publish, context) => {
      context.deliveryReceipt?.("stored");
    },
    undefined,
    undefined,
    false,
    "another-seat",
    { deviceId: "another-app", ref: "thread:proof-250" },
  );
  await seeded.close();
  const captain = createCaptain(
    {
      leadWakes,
      herdrAvailable: () => true,
      embodiment: { getLiveSession: async () => undefined },
      memory: {},
      browser: { catalog: async () => ({ available: false, tools: [] }) },
      mcp: { catalog: async () => [] },
      media: { finishedRenders: async () => [] },
    } as unknown as CaptainDeps,
    {
      repoRoot: root,
      stateDir: root,
      workingDirectory: root,
      settings,
      discordEnvironment: {},
      seatAdapters: [adapter],
      projectHireTools: async () => [],
      projectHireIdentity: async (fleet, selectedPane) => ({
        fleet,
        pane: selectedPane,
        nativeOccupantId: occupantIdForHerdrSession(snapshot().session!),
        binding: { socketPath: join(root, "herdr.sock") },
        shell: { pid: process.pid, startTime: "fixture-shell" },
        processes: [{ pid: process.pid, startTime: "fixture-native" }],
      }),
      nativeLaunchPolicy: {
        admit: async () => {},
        prepare: async () => ({
          account: { label: "protocol-fixture", home: root },
          args: [],
          env: { CODEX_HOME: root },
        }),
      },
      nativeHerdrRunner: {
        createTab: async () => pane.pane_id,
        startAgent: async ({ name }) => {
          pane.name = name;
          native.startView();
        },
        get: async () => snapshot(),
        resolveTerminal: async () => snapshot(),
        wait: async (_target, signal) =>
          new Promise<never>((_resolve, reject) => {
            signal?.addEventListener("abort", () => reject(new Error("closed")), { once: true });
          }),
        paneProcesses: async () => [
          { pid: 12345, name: "codex", argv: ["codex", "--remote", native.endpoint] },
        ],
        closePane: async () => {},
        runInPane: async () => {
          throw new Error("No terminal input fallback permitted");
        },
      },
      nativeCensusRunner: async (_cmd, args) => ({
        stdout: JSON.stringify({
          result: args[0] === "agent" ? { agents: [pane] } : { snapshot: { agents: [pane] } },
        }),
        stderr: "",
      }),
    },
  );
  return {
    captain,
    native,
    pane,
    report: (text: string) =>
      captain.receiveFleetSeatMessage(pane.pane_id, text, {
        id: randomUUID(),
        binding: deliveryFingerprint(
          JSON.stringify([pane.pane_id, pane.terminal_id, pane.agent, snapshot().session]),
        ),
      }),
    async close() {
      usage.mockRestore();
      await captain.close();
      await native.close();
    },
  };
}
