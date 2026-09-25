import { expect, test } from "vitest";
import { AgentHostConnectionSchema, ClankieSettingsSchema, emptySettings } from "../src/index.ts";

test("agent transcript hosts default empty and accept named SSH destinations", () => {
  expect(emptySettings().agentHosts).toEqual({ connections: [] });
  expect(
    AgentHostConnectionSchema.parse({ id: "pc", ssh: "volpe@supedupsilly", shell: "powershell" }),
  ).toEqual({ id: "pc", ssh: "volpe@supedupsilly", shell: "powershell" });
});
test("agent transcript hosts reject duplicate IDs, local override and injected SSH arguments", () => {
  const connection = { id: "pc", ssh: "volpe@supedupsilly", shell: "powershell" };
  expect(() =>
    ClankieSettingsSchema.parse({
      ...emptySettings(),
      agentHosts: { connections: [connection, connection] },
    }),
  ).toThrow("unique");
  expect(() => AgentHostConnectionSchema.parse({ ...connection, id: "local" })).toThrow("reserved");
  for (const ssh of ["-oProxyCommand=evil", "pc;evil", "pc\ncommand", "user@pc -p 22"])
    expect(() => AgentHostConnectionSchema.parse({ ...connection, ssh })).toThrow();
});
