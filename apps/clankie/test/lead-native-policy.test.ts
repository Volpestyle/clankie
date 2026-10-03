import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
// @ts-expect-error -- manual checkout-only ESM runner.
import * as policy from "../../../scripts/evals/lead-native-policy.mjs";
// @ts-expect-error -- manual checkout-only ESM runner.
import { LeadContainer } from "../../../scripts/evals/lead-containment.mjs";
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const root = mkdtempSync(join(realpathSync(tmpdir()), "native-config-"));
  roots.push(root);
  const hostCwd = join(root, "tasks/one"),
    accountHome = join(root, "control/one/auth");
  mkdirSync(hostCwd, { recursive: true, mode: 0o700 });
  mkdirSync(accountHome, { recursive: true, mode: 0o700 });
  writeFileSync(join(accountHome, "auth.json"), "{}", { mode: 0o600 });
  return { root, hostCwd, accountHome };
}
it("rejects project/ancestor configuration, mixed account homes and auth symlinks before native launch", async () => {
  const f = fixture();
  await policy.validateNativeLaunchState(f);
  for (const path of [
    join(f.hostCwd, "config.toml"),
    join(f.root, "config.toml"),
    join(f.accountHome, "config.toml"),
  ]) {
    writeFileSync(path, '[mcp_servers.evil]\ncommand="anything"', { mode: 0o600 });
    await expect(policy.validateNativeLaunchState(f)).rejects.toThrow();
    rmSync(path);
  }
  const original = join(f.accountHome, "auth.json");
  rmSync(original);
  symlinkSync(join(f.root, "missing"), original);
  await expect(policy.validateNativeLaunchState(f)).rejects.toThrow("regular");
});
it("validates pinned config/read option-null serialization and refuses merged execution authorities", async () => {
  const cwd = "/eval/tasks/one",
    codexHome = "/eval/control/one/auth";
  const locked = {
    approval_policy: "never",
    mcp_servers: {},
    features: { multi_agent: false },
    web_search: "disabled",
    default_permissions: "lead_eval",
    permissions: { lead_eval: policy.nativePermissionProfile(cwd) },
  };
  const response = {
    config: {
      ...structuredClone(locked),
      notify: null,
      hooks: null,
      plugins: {},
      model_providers: {},
      permissions: {
        lead_eval: {
          ...structuredClone(locked.permissions.lead_eval),
          description: null,
          extends: null,
          workspace_roots: null,
        },
      },
    },
    origins: {},
    layers: [
      { name: { type: "sessionFlags" }, version: "fixture", config: structuredClone(locked) },
      {
        name: { type: "user", file: `${codexHome}/config.toml`, profile: null },
        version: "empty",
        config: {},
      },
    ],
  };
  expect(await policy.validateEffectiveNativeConfig(response, { cwd, codexHome })).toMatchObject({
    layerCount: 2,
    sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
  });
  for (const extra of [
    { mcp_servers: { evil: { command: "sh" } } },
    { hooks: { run: "x" } },
    {
      permissions: {
        lead_eval: {
          ...locked.permissions.lead_eval,
          filesystem: { ...locked.permissions.lead_eval.filesystem, "/eval/control": "read" },
        },
      },
    },
  ]) {
    await expect(
      policy.validateEffectiveNativeConfig(
        { ...response, config: { ...response.config, ...extra } },
        { cwd, codexHome },
      ),
    ).rejects.toThrow("locked");
  }
  await expect(
    policy.validateEffectiveNativeConfig(
      { ...response, layers: [...response.layers, { name: { type: "future" }, version: "x", config: {} }] },
      { cwd, codexHome },
    ),
  ).rejects.toThrow("authority");
});
it("refuses every native lifecycle action with imported or missing capability proof before a Docker command", async () => {
  const f = fixture(),
    command = vi.fn();
  const container = new LeadContainer({
    image: `sha256:${"a".repeat(64)}`,
    root: f.root,
    command,
    capability: { image: `sha256:${"a".repeat(64)}`, evidence: { complete: true } },
  });
  for (const action of [
    () => container.create(["codex"]),
    () => container.start(),
    () => container.exec(["codex"]),
    () => container.pipe(["codex"]),
    () => container.attach(["herdr"]),
  ]) {
    await expect(action()).rejects.toThrow("controller-origin");
  }
  expect(command).not.toHaveBeenCalled();
});
