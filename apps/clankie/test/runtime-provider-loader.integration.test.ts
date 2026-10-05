import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { build } from "esbuild";
import { afterEach, expect, it } from "vitest";

const run = promisify(execFile);
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

// Compile the real loader and an independently packaged host provider. Each
// boot below is a fresh Node process, as with the launcher's index.js restart.
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "clankie-provider-loader-"));
  roots.push(root);
  const state = join(root, "state");
  await mkdir(state);
  const app = fileURLToPath(new URL("..", import.meta.url));
  const entry = join(root, "entry.mjs");
  await build({
    stdin: {
      resolveDir: app,
      sourcefile: "runtime-provider-fixture.ts",
      contents: `
        import { loadRuntimeProvider } from './src/runtime-provider.ts';
        import { FileCredentialStore } from '@clankie/credential-broker';
        import { join } from 'node:path';
        const stateRoot = process.argv[2];
        const providerPath = process.argv[3];
        const env = providerPath === 'absent' ? {} : { CLANKIE_RUNTIME_PROVIDER_MODULE: providerPath };
        if (process.argv[4] === 'managed') env.CLANKIE_HOSTED_BOOTSTRAP_FILE = 'fixture-managed-bootstrap';
        try {
          const provider = await loadRuntimeProvider({
            env, stateRoot, store: new FileCredentialStore(join(stateRoot, 'credentials.json')),
            herdrAvailable: () => false, logger: { info() {}, warn() {} }
          });
          provider.heartbeat?.start();
          provider.heartbeat?.activitySharing(true);
          provider.heartbeat?.activitySharing(false);
          const router = provider.quota?.routes(async request =>
            request.headers.get('authorization') === 'Bearer fixture-owner' ? true : 'authentication_required');
          const denied = router && await router.request('/v1/provider-check');
          const admitted = router && await router.request('/v1/provider-check',
            { headers: { authorization: 'Bearer fixture-owner' } });
          const capacity = await provider.quota?.hireCapacity?.();
          await provider.model?.onChanged();
          provider.heartbeat?.close();
          await provider.model?.close();
          process.stdout.write(JSON.stringify({
            hooks: Object.keys(provider), denied: denied?.status, admitted: admitted?.status,
            data: admitted && await admitted.json(), capacity
          }));
        } catch (error) {
          process.stderr.write(error instanceof Error ? error.message : 'unknown_error');
          process.exitCode = 2;
        }
      `,
    },
    outfile: entry,
    bundle: true,
    platform: "node",
    format: "esm",
    // proper-lockfile is CJS; the native createRequire bridge preserves it in
    // the same ESM artifact format as the service's installed entry.
    banner: {
      js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);",
    },
  });
  const provider = join(root, "provider.mjs");
  await build({
    stdin: {
      resolveDir: app,
      sourcefile: "private-runtime-fixture.ts",
      contents: `
        import { Hono } from 'hono';
        import { appendFileSync } from 'node:fs';
        import { join } from 'node:path';
        export async function createRuntimeProvider(context) {
          const previous = await context.store.get('fixture-provider-boots');
          const boot = previous ? Number(previous.key) + 1 : 1;
          await context.store.set('fixture-provider-boots', { type: 'api', key: String(boot) });
          const report = value => appendFileSync(join(context.stateRoot, 'provider-events'), value + '\\n');
          report('initialized:' + boot);
          return {
            quota: {
              routes(authorize) {
                return new Hono().get('/v1/provider-check', async c => {
                  const grant = await authorize(c.req.raw);
                  return grant === true ? c.json({ boot }) : c.json({ error: grant }, 401);
                });
              },
              hireCapacity: async () => ({ live: boot, limit: 4 })
            },
            heartbeat: {
              begin() { return () => {}; }, interactive() {}, authenticatedWork() {},
              activitySharing(active) { report('activity:' + boot + ':' + active); },
              start() { report('started:' + boot); }, close() { report('heartbeat_closed:' + boot); }
            },
            model: {
              async piSeatModel() { return undefined; },
              async onChanged() { report('model_changed:' + boot); },
              async close() { report('model_closed:' + boot); }
            }
          };
        }
      `,
    },
    outfile: provider,
    bundle: true,
    platform: "node",
    format: "esm",
  });
  const boot = async (path = provider, managed = false) =>
    JSON.parse(
      (
        await run(process.execPath, [entry, state, path, managed ? "managed" : "ordinary"], {
          timeout: 10_000,
        })
      ).stdout,
    );
  return { root, state, entry, provider, boot };
}

it("fresh service processes load the installed provider each time and retain its broker state", async () => {
  const f = await fixture();
  for (const boot of [1, 2])
    expect(await f.boot()).toEqual({
      hooks: ["quota", "heartbeat", "model"],
      denied: 401,
      admitted: 200,
      data: { boot },
      capacity: { live: boot, limit: 4 },
    });
  expect(await readFile(join(f.state, "provider-events"), "utf8")).toBe(
    [1, 2]
      .flatMap((boot) => [
        `initialized:${boot}`,
        `started:${boot}`,
        `activity:${boot}:true`,
        `activity:${boot}:false`,
        `model_changed:${boot}`,
        `heartbeat_closed:${boot}`,
        `model_closed:${boot}`,
      ])
      .join("\n") + "\n",
  );
});

it("managed startup requires all policy capabilities and validates exact supplemental gateway routes", async () => {
  const f = await fixture();
  await expect(f.boot("absent", true)).rejects.toMatchObject({
    code: 2,
    stderr: "runtime_provider_required",
  });
  const invalid = join(f.root, "managed-provider.mjs");
  for (const source of [
    "return {};",
    "return { quota: { routes() {} } };",
    "return { quota: { routes() {}, hireCapacity: async () => undefined }, heartbeat: { begin() {}, interactive() {}, authenticatedWork() {}, activitySharing() {}, start() {}, close() {} }, model: { async onChanged() {}, async close() {} } };",
  ]) {
    await writeFile(invalid, `export async function createRuntimeProvider() { ${source} }`);
    await expect(f.boot(invalid, true)).rejects.toMatchObject({
      code: 2,
      stderr: "managed_runtime_provider_incomplete",
    });
  }
  for (const hook of ["", "activitySharing: false,"]) {
    await writeFile(
      invalid,
      `export async function createRuntimeProvider() {
        return {
          quota: { routes() {}, hireCapacity: async () => undefined },
          heartbeat: { begin() {}, interactive() {}, authenticatedWork() {}, ${hook} start() {}, close() {} },
          model: { async piSeatModel() {}, async onChanged() {}, async close() {} }
        };
      }`,
    );
    await expect(f.boot(invalid, true)).rejects.toMatchObject({
      code: 2,
      stderr: "runtime_provider_invalid",
    });
  }
  for (const routes of [
    [{ method: "PUT", path: "/v1/extension/read", target: "control" }],
    [{ method: "GET", path: "/v1/extension/*", target: "control" }],
    [{ method: "GET", path: "/v1/extension/read?claim=1", target: "control" }],
    [{ method: "GET", path: "/v1/extension/read", target: "admin" }],
    [{ method: "GET", path: "/v1/devices/self", target: "relay" }],
    [{ method: "POST", path: "/v1/gateway/encrypted", target: "control" }],
    [{ method: "POST", path: "/v1/admin/claim", target: "control" }],
    [{ method: "POST", path: "/operator/v1/dispatch", target: "control" }],
    [{ method: "GET", path: "/fleet/v1/secret", target: "control" }],
    [
      { method: "GET", path: "/v1/extension/read", target: "control" },
      { method: "GET", path: "/v1/extension/read", target: "relay" },
    ],
  ]) {
    await writeFile(
      invalid,
      `export async function createRuntimeProvider() {
      return { quota: { routes() {}, gatewayRoutes: ${JSON.stringify(routes)} } };
    }`,
    );
    await expect(f.boot(invalid)).rejects.toMatchObject({
      code: 2,
      stderr: "runtime_provider_gateway_routes_invalid",
    });
  }
  // Negative startup never touched the broker or initialized the hosted policy.
  await expect(readFile(join(f.state, "credentials.json"))).rejects.toMatchObject({ code: "ENOENT" });
  expect((await f.boot(f.provider, true)).hooks).toEqual(["quota", "heartbeat", "model"]);
});

it("an ordinary process supplies no policy, while an explicitly invalid installation fails startup", async () => {
  const f = await fixture();
  expect(await f.boot("absent")).toEqual({ hooks: [] });
  await expect(readFile(join(f.state, "credentials.json"))).rejects.toMatchObject({ code: "ENOENT" });
  await expect(f.boot("./relative-provider.mjs")).rejects.toMatchObject({
    code: 2,
    stderr: "runtime_provider_module_absolute_path_required",
  });
  const invalid = join(f.root, "invalid-provider.mjs");
  await writeFile(invalid, "export async function createRuntimeProvider() { return { heartbeat: {} }; }");
  await expect(f.boot(invalid)).rejects.toMatchObject({ code: 2, stderr: "runtime_provider_invalid" });
  await writeFile(invalid, "export default async function factory() { return {}; }");
  await expect(f.boot(invalid)).rejects.toMatchObject({
    code: 2,
    stderr: "runtime_provider_factory_required",
  });
  await writeFile(
    invalid,
    "export async function createRuntimeProvider() { throw new Error('policy_initialization_failed'); }",
  );
  await expect(f.boot(invalid)).rejects.toMatchObject({ code: 2, stderr: "policy_initialization_failed" });
  await expect(readFile(join(f.state, "credentials.json"))).rejects.toMatchObject({ code: "ENOENT" });
});
