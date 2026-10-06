import { isolatedCodexConfig } from "./codex-catalog-refresh.ts";

interface Hook {
  key: string;
  currentHash: string;
  source: string;
  enabled: boolean;
  trustStatus: string;
}

/**
 * Hiring authorizes Clankie's installed worker hooks in this copied home.
 * Codex owns discovery and hashing. Other plugins and changed owner hooks
 * retain their native review; no global bypass or owner configuration write.
 */
export async function trustInstalledCodexWorkerHooks(input: {
  home: string;
  cwd: string;
  request(method: string, params: Record<string, unknown>): Promise<unknown>;
}): Promise<void> {
  const configPath = await isolatedCodexConfig(input.home);
  const list = async (): Promise<Hook[]> => {
    const result = (await input.request("hooks/list", { cwds: [input.cwd] })) as {
      data?: { cwd?: string; hooks?: Hook[]; errors?: unknown[] }[];
    };
    const entry = result.data?.find((value) => value.cwd === input.cwd);
    if (!entry || !Array.isArray(entry.hooks) || !Array.isArray(entry.errors) || entry.errors.length)
      throw new Error("Codex worker hook discovery unavailable");
    return entry.hooks;
  };
  const hooks = (await list()).filter(
    (hook) =>
      hook.source === "plugin" &&
      hook.enabled !== false &&
      typeof hook.key === "string" &&
      hook.key.startsWith("clankie-worker@clankie-fleet:") &&
      ["untrusted", "modified"].includes(hook.trustStatus),
  );
  if (!hooks.length) return;
  for (const hook of hooks)
    if (!/^sha256:[a-f0-9]{64}$/u.test(hook.currentHash))
      throw new Error("Codex worker hook hash unavailable");
  await input.request("config/batchWrite", {
    filePath: configPath,
    expectedVersion: null,
    reloadUserConfig: true,
    edits: [
      {
        keyPath: "hooks.state",
        mergeStrategy: "upsert",
        value: Object.fromEntries(hooks.map((hook) => [hook.key, { trusted_hash: hook.currentHash }])),
      },
    ],
  });
  const verified = await list();
  for (const hook of hooks)
    if (
      !verified.some(
        (value) =>
          value.key === hook.key && value.currentHash === hook.currentHash && value.trustStatus === "trusted",
      )
    )
      throw new Error("Codex worker hooks changed during trust; retry discovery on the next hire");
}
