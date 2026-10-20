import { expect, it } from "vitest";
import { requestPairingOffer } from "../../tui/bin/pairing-offer.ts";
import { runDevicesCommand } from "../../tui/src/command/devices.ts";
import { runPairCommand } from "../../tui/src/command/pair.ts";
import { createQaService } from "./fixtures/qa-service.ts";

// Real HTTP, signed credentials, native child process and durable teardown.
// CI exercises child teardown. An explicit owned simulator enables the native capture proof.
it("a simulator capture command leaves no active pairing after success or failure", async () => {
  const host = await createQaService();
  host.advance(Date.now() - host.now());
  let messages = "";
  const output = {
    write: (text: string) => {
      messages += text;
    },
  };
  const capture = `
    const base = process.env.CLANKIE_CONTROL_PLANE_URL;
    const post = async (path, body) => {
      const response = await fetch(base + path, { method: 'POST',
        headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
      if (!response.ok) throw new Error(path + ': ' + response.status);
      return response.json();
    };
    const pending = await post('/v1/pairing/redeem', { code: process.env.CLANKIE_PAIRING_CODE,
      device: { name: 'Simulator capture', platform: 'ios' } });
    const paired = await post('/v1/pairing/complete', { completionToken: pending.completionToken,
      acceptedGrants: pending.offeredGrants });
    const self = await fetch(base + '/v1/devices/self', {
      headers: { authorization: 'Bearer ' + paired.deviceToken } });
    if (!self.ok) throw new Error('capture could not read device');
    if (process.env.VUH_2565_SIMULATOR_UDID) {
      const { execFileSync } = await import('node:child_process');
      execFileSync('xcrun', ['simctl', 'io', process.env.VUH_2565_SIMULATOR_UDID,
        'screenshot', process.env.VUH_2565_CAPTURE_ROOT + '/capture-' + process.env.CAPTURE_EXIT + '.png'], { stdio: 'inherit' });
    }
    process.exit(Number(process.env.CAPTURE_EXIT));
  `;
  try {
    for (const status of [0, 7]) {
      const code = await runPairCommand(
        [
          "--run",
          `capture-${status}`,
          "--purpose",
          "simulator",
          "--",
          process.execPath,
          "--input-type=module",
          "-e",
          capture,
        ],
        {
          repoRoot: process.cwd(),
          host: host.baseUrl,
          env: {
            ...process.env,
            CLANKIE_OPERATOR_TOKEN: host.operatorToken,
            CLANKIE_CONTROL_PLANE_URL: host.baseUrl,
            // The pairing wrapper probes this isolated host's real HTTP health.
            // No installed service or default port is contacted or started.
            CLANKIE_RELAY_PORT: new URL(host.baseUrl).port,
            CAPTURE_EXIT: String(status),
          },
          stdout: output,
          stderr: output,
        },
      );
      expect(code, messages).toBe(status);
      const response = await fetch(host.baseUrl + "/v1/devices", {
        headers: { authorization: `Bearer ${host.operatorToken}` },
      });
      const devices = await response.json();
      expect(devices).toHaveLength(status === 0 ? 1 : 2);
      expect(devices.every((device: { status: string }) => device.status === "revoked")).toBe(true);
      expect(devices.at(-1).run.purpose).toBe("simulator");
      let deviceRows = "";
      expect(
        await runDevicesCommand(["--grouped", "--json"], {
          host: host.baseUrl,
          env: { ...process.env, CLANKIE_OPERATOR_TOKEN: host.operatorToken },
          stdout: {
            write: (text) => {
              deviceRows += text;
            },
          },
          stderr: output,
        }),
      ).toBe(0);
      const listed = JSON.parse(deviceRows);
      expect(listed.devices).toHaveLength(devices.length);
      expect(
        listed.devices.every(
          (row: { status: string; pairingIds: string[] }) =>
            row.status === "revoked" && row.pairingIds.length === 1,
        ),
      ).toBe(true);
    }
  } finally {
    await host.close();
  }
});

it("refuses an older service that silently ignores automation metadata", async () => {
  const host = await createQaService();
  host.advance(Date.now() - host.now());
  try {
    await expect(
      requestPairingOffer({
        controlPlaneUrl: host.baseUrl,
        operatorToken: host.operatorToken,
        run: { runId: "old-service", purpose: "test", ttlSeconds: 900 },
        // Compatibility carrier models the old wire response using the real HTTP producer.
        fetchImpl: async (input, init) => {
          const response = await fetch(input, init);
          const { run: _run, ...oldWire } = await response.json();
          return Response.json(oldWire);
        },
      }),
    ).rejects.toThrow("did not confirm an automation pairing lifetime");
  } finally {
    await host.close();
  }
});
