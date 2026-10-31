import type { CredentialStore } from "@clankie/credential-broker";
import { expect, it } from "vitest";
import { runConnectorCommand } from "../src/command/connector.ts";

const store = {
  get: async () => ({ type: "api", key: `clankie_op_${"a".repeat(43)}` }),
} as unknown as CredentialStore;

function capture() {
  let out = "";
  let err = "";
  return {
    stdout: { write: (chunk: string) => (out += chunk) },
    stderr: { write: (chunk: string) => (err += chunk) },
    text: () => out,
    error: () => err,
  };
}

it("turns Herdr detection off and a connected app off", async () => {
  const bodies: unknown[] = [];
  let herdr = true;
  let served = true;
  const status = () => ({
    multiplexers: [{ id: "herdr", enabled: herdr }],
    apps: [{ deviceId: "device-grok", name: "Grok", served }],
  });
  const fetchImpl = (async (_url: URL, init?: RequestInit) => {
    if (init?.method === "POST") {
      const body = JSON.parse(String(init.body)) as {
        multiplexer?: string;
        enabled?: boolean;
        deviceId?: string;
        served?: boolean;
      };
      bodies.push(body);
      if (body.multiplexer === "herdr") herdr = body.enabled === true;
      if (body.deviceId === "device-grok") served = body.served === true;
    }
    return Response.json(status());
  }) as typeof fetch;
  const detected = capture();
  expect(
    await runConnectorCommand(["detect", "off", "herdr"], {
      env: {},
      host: "http://127.0.0.1:4310",
      fetchImpl,
      operatorCredentialStore: store,
      stdout: detected.stdout,
      stderr: detected.stderr,
    }),
  ).toBe(0);
  expect(bodies).toContainEqual({ multiplexer: "herdr", enabled: false });
  expect(detected.text()).toContain("Herdr: off");

  const servedOut = capture();
  expect(
    await runConnectorCommand(["serve", "off", "Grok", "--json"], {
      env: {},
      host: "http://127.0.0.1:4310",
      fetchImpl,
      operatorCredentialStore: store,
      stdout: servedOut.stdout,
      stderr: servedOut.stderr,
    }),
  ).toBe(0);
  expect(bodies).toContainEqual({ deviceId: "device-grok", served: false });
  expect(JSON.parse(servedOut.text())).toMatchObject({
    ok: true,
    apps: [{ name: "Grok", served: false }],
  });

  const unknown = capture();
  expect(
    await runConnectorCommand(["detect", "off", "tmux"], {
      env: {},
      host: "http://127.0.0.1:4310",
      fetchImpl,
      operatorCredentialStore: store,
      stdout: unknown.stdout,
      stderr: unknown.stderr,
    }),
  ).toBe(1);
  expect(unknown.error()).toContain("isn't a multiplexer");
});
