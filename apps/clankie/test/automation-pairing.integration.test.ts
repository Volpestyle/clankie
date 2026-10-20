import { expect, it } from "vitest";
import { runPairCommand } from "../../tui/src/command/pair.ts";
import { createQaService } from "./fixtures/qa-service.ts";

// Real HTTP, signed credentials, native child process and durable teardown.
// No Simulator boot is claimed: this exercises the wrapper used by capture commands.
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
    }
  } finally {
    await host.close();
  }
});
