import { test, expect } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";

test("relocated release includes executable Swarm dependencies and skill sources", async () => {
  const root = await mkdtemp("/tmp/clankie-swarm-release-test-");
  const repo = fileURLToPath(new URL("../../../", import.meta.url));
  const helper = new URL("../../../scripts/release/swarm-runtime.mjs", import.meta.url).href;
  try {
    const result = await promisify(execFile)(
      process.execPath,
      [
        "--input-type=module",
        "--eval",
        `
      import { copySwarmRuntime } from ${JSON.stringify(helper)};
      import { readFile } from 'node:fs/promises';
      import { dirname, join } from 'node:path';
      import { createRequire } from 'node:module';
      await copySwarmRuntime(${JSON.stringify(repo)}, process.cwd());
      const require = createRequire(join(process.cwd(), 'package.json'));
      const path = require.resolve('swarm-mcp/package.json');
      const runtime = await import(join(dirname(path), 'dist/coordination/runtime.js'));
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
}, 30000);
