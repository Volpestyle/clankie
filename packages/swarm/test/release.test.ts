import { test, expect } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

test("relocated release includes executable Swarm dependencies and skill sources", async () => {
  const root = await mkdtemp("/tmp/clankie-swarm-release-test-");
  const repo = fileURLToPath(new URL("../../../", import.meta.url));
  const helper = new URL("../../../scripts/release/swarm-runtime.mjs", import.meta.url).href;
  try {
    // Copying the release is filesystem setup, not runtime startup. Keep the
    // child deadline focused on enrollment/bootstrap even on a busy build host.
    const { copySwarmRuntime } = await import(helper);
    await copySwarmRuntime(repo, root);
    const result = await promisify(execFile)(
      process.execPath,
      [
        "--input-type=module",
        "--eval",
        `
      import { readFile } from 'node:fs/promises';
      import { dirname, join } from 'node:path';
      import { createRequire } from 'node:module';
      const require = createRequire(join(process.cwd(), 'package.json'));
      const path = require.resolve('swarm-mcp/package.json');
      const runtime = await import(join(dirname(path), 'dist/coordination/runtime.js'));
      const extension = await import(join(dirname(path), 'dist/coordination/pi-worker-extension.js'));
      if (typeof extension.default !== 'function') throw new Error('Managed pi extension failed to load');
      const state = join(process.cwd(), 'state');
      const enrolled = await runtime.enrollRuntime({ stateDirectory: state,
        nodePath: process.execPath, ownerPath: join(dirname(path), 'dist/coordination/owner-cli.js'),
        host: 'pi', hostSessionId: 'release', incarnation: 'one',
        identity: { directory: process.cwd(), fileRoot: process.cwd(), projectRoot: process.cwd(), profile: 'test' } });
      try {
        const client = await runtime.CoordinationClient.connect(enrolled.environment.SWARM_COORDINATOR_ENDPOINT, enrolled.environment.SWARM_SESSION_CAPABILITY);
        try { await client.request({op:'bootstrap'}); } finally { client.close(); }
        for(const skill of ['lead','swarm-lead','herdr-lead']) await readFile(join(process.cwd(), 'node_modules/@volpestyle/lead-skills',skill,'SKILL.md'));
        await readFile(join(process.cwd(), 'node_modules/@volpestyle/lead-skills/LICENSE'));
        console.log('release runtime ready');
      } finally { enrolled.launchedOwner?.kill(); }
    `,
      ],
      { cwd: root, timeout: 20000 },
    );
    expect(result.stdout).toContain("release runtime ready");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 90000);

test("vendored Swarm manifest dependencies are retained in the pnpm snapshot", async () => {
  const repo = fileURLToPath(new URL("../../../", import.meta.url));
  const { stdout } = await promisify(execFile)("tar", [
    "-xOf",
    `${repo}/vendor/swarm-mcp-2.0.0-rc.1.tgz`,
    "package/package.json",
  ]);
  const manifest = JSON.parse(stdout);
  const lock = await readFile(`${repo}/pnpm-lock.yaml`, "utf8");
  const snapshots = lock.split("\nsnapshots:\n")[1]!;
  const block = snapshots.match(
    /\n  swarm-mcp@file:vendor\/swarm-mcp-2\.0\.0-rc\.1\.tgz:\n([\s\S]*?)(?=\n  \S|$)/,
  )?.[1];
  expect(block).toBeDefined();
  const retained = [...block!.matchAll(/^      (?:'([^']+)'|([^ :]+)):/gm)].map(
    (match) => match[1] ?? match[2],
  );
  for (const dependency of Object.keys(manifest.dependencies)) expect(retained).toContain(dependency);
});
