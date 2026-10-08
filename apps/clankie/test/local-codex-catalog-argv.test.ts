import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { verifyLocalCodexCatalogOverrides } from "../src/captain/local-codex-catalog-coordinator.ts";

// Golden from the owned native launch that refused VUH-1739's live refresh.
const { argv } = JSON.parse(
  readFileSync(new URL("./fixtures/managed-codex-catalog-argv.json", import.meta.url), "utf8"),
) as { argv: string[] };

it("accepts the observed managed launch while refusing changed or unknown bridge overrides", () => {
  expect(() => verifyLocalCodexCatalogOverrides(argv)).not.toThrow();
  const older = [...argv];
  const approval = older.findIndex((arg) =>
    arg.startsWith("mcp_servers.clankie.default_tools_approval_mode="),
  );
  older.splice(approval - 1, 2);
  expect(() => verifyLocalCodexCatalogOverrides(older)).not.toThrow();
  expect(() =>
    verifyLocalCodexCatalogOverrides([
      ...argv,
      "-c",
      'mcp_servers.clankie.env.CLANKIE_CATALOG_REVISION="caller-chosen"',
    ]),
  ).toThrow("native_codex_bridge_override_unproven");
  expect(() =>
    verifyLocalCodexCatalogOverrides(
      argv.map((arg) =>
        arg.startsWith("mcp_servers.clankie.default_tools_approval_mode=")
          ? 'mcp_servers.clankie.default_tools_approval_mode="prompt"'
          : arg,
      ),
    ),
  ).toThrow("original_codex_tui_bridge_not_managed_fleet");
  expect(() =>
    verifyLocalCodexCatalogOverrides([...argv, "-c", 'mcp_servers.clankie.command="another-bridge"']),
  ).toThrow("native_codex_bridge_override_unproven");
});
