import { execFile } from "node:child_process";
import { once } from "node:events";
import { promisify } from "node:util";
import { createHash, randomUUID } from "node:crypto";
import {
  chmod,
  copyFile,
  link,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { serve } from "@hono/node-server";
import { beforeAll, expect, it } from "vitest";
import { LocalFleetLink } from "../src/local-fleet-link.ts";
import { NativeFixtureAdmissions } from "../src/native-fixture-admissions.ts";
import { createFixtureBootstrap } from "../src/fixture-admission-bootstrap.ts";
import { fleetProcessHelper, observeSocketProcess } from "../src/local-fleet-process.ts";
import { runFixtureAdmission } from "../../tui/src/command/fixture-admission.ts";

const repoRoot = resolve(import.meta.dirname, "../../..");
// Source checkouts build the kernel helper and the pinned fixture artifact the host trusts.
beforeAll(async () => {
  for (const script of ["build-fleet-proof.mjs", "build-fixture-read.mjs"])
    await promisify(execFile)(process.execPath, [join(repoRoot, "scripts", script)], { timeout: 120_000 });
}, 130_000);
// A private copy of the pinned inputs, so changing them never races other tests' shared artifact.
// Laid out as a Linux pnpm install leaves it on every platform (#304): each virtual-store
// dependency input is a hardlink to its own store copy, so it has two links.
const pnpmStoreInput = (path: string) => path.startsWith("node_modules/.pnpm/");
const privateRepoCopy = async (root: string) => {
  const copy = join(root, "repo"),
    store = join(root, "pnpm-store");
  const pinned = JSON.parse(await readFile(join(repoRoot, ".local/fixture-read/manifest.json"), "utf8")) as {
    inputs: { path: string }[];
  };
  const inputs = pinned.inputs.map((input) => input.path);
  for (const path of [
    ".local/fixture-read/manifest.json",
    ".local/fixture-read/worker.mjs",
    relative(repoRoot, fleetProcessHelper(repoRoot)),
    ...inputs,
  ]) {
    await mkdir(dirname(join(copy, path)), { recursive: true });
    if (!pnpmStoreInput(path)) {
      await copyFile(join(repoRoot, path), join(copy, path));
      continue;
    }
    const stored = join(store, path);
    await mkdir(dirname(stored), { recursive: true });
    await copyFile(join(repoRoot, path), stored);
    await link(stored, join(copy, path));
  }
  const linked = inputs.filter(pnpmStoreInput);
  expect(linked.length).toBeGreaterThan(0);
  for (const path of linked) expect((await stat(join(copy, path))).nlink).toBe(2);
  return { copy, store, inputs };
};
const address = async (server: ReturnType<typeof serve>) => {
  if (!server.listening) await once(server, "listening");
  const value = server.address();
  if (!value || typeof value === "string") throw new Error("Owned listener unavailable");
  return `http://127.0.0.1:${value.port}`;
};
const close = (server: ReturnType<typeof serve>) =>
  new Promise<void>((resolveClose) => server.close(() => resolveClose()));

it("original admission requires project proof and cannot use broad membership or generic forwarding", async () => {
  const root = await mkdtemp(join(tmpdir(), "fixture-route-denial-"));
  let broad = 0,
    project = 0,
    forward = 0,
    handled = 0;
  const link = new LocalFleetLink({
    directory: root,
    binding: async () => undefined,
    prove: async () => {
      broad++;
      return true;
    },
    projectProof: async () => {
      project++;
      return undefined;
    },
    fixtureAdmission: async () => {
      handled++;
      return Response.json({ unexpected: true });
    },
  });
  const server = serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: link.fetch(() => {
      forward++;
      return Response.json({ generic: true });
    }),
  });
  try {
    const origin = await address(server);
    const response = await fetch(`${origin}/v1/fleet/seats/w1%3Ap1/fixture-admissions`, {
      method: "POST",
      headers: { "x-clankie-pane": "w1:p1" },
      body: "{}",
    });
    expect(response.status).toBe(403);
    expect(project).toBe(1);
    expect(broad).toBe(0);
    expect(forward).toBe(0);
    expect(handled).toBe(0);
    expect((await fetch(`${origin}/v1/fixture-admission/verify`, { method: "POST" })).status).toBe(404);
    expect(forward).toBe(0);
  } finally {
    await close(server);
    await link.close();
    await rm(root, { recursive: true, force: true });
  }
});

it("separate callback listener has no pane/MCP/catalog or dispatch fallback", async () => {
  const stateRoot = await realpath(await mkdtemp(join(tmpdir(), "fixture-callback-state-")));
  let originalCalls = 0,
    bootstrapCalls = 0;
  const admission = new NativeFixtureAdmissions({
    stateRoot,
    processHelper: fleetProcessHelper(repoRoot),
    bootstrap: async () => {
      bootstrapCalls++;
      throw new Error("No fixture for denied request");
    },
    verifier: {
      capture: async () => {
        originalCalls++;
        throw new Error("No original proof");
      },
      reprove: async () => {
        originalCalls++;
        throw new Error("No original proof");
      },
    },
  });
  try {
    const origin = await admission.startCallbackListener();
    for (const path of [
      "/v1/fleet/mcp",
      "/v1/fleet/seats/w1:p1/fixture-admissions",
      "/v1/worker-mcp",
      "/catalog",
    ])
      expect((await fetch(`${origin}${path}`, { method: "POST", body: "{}" })).status).toBe(404);
    expect(
      (await fetch(`${origin}/v1/fixture-admission/verify`, { method: "POST", body: "{}" })).status,
    ).toBe(403);
    expect(originalCalls).toBe(0);
    expect(bootstrapCalls).toBe(0);
  } finally {
    await admission.close();
    await rm(stateRoot, { recursive: true });
  }
});

it.skipIf(!["darwin", "linux"].includes(process.platform))(
  "owned artifact bootstrap pins actual child lifetime; denied verification never reads domain data",
  async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "fixture-owned-bootstrap-")));
    // Its pnpm dependency inputs are hardlinked to a store copy, as a Linux install leaves them.
    const { copy } = await privateRepoCopy(root);
    let callbacks = 0,
      callbackPid: number | undefined;
    const callback = serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: async (request, env) => {
        expect(new URL(request.url).pathname).toBe("/v1/fixture-admission/verify");
        callbacks++;
        callbackPid = (await observeSocketProcess(env.incoming.socket, fleetProcessHelper(repoRoot)))?.owner
          .pid;
        return Response.json({ error: "denied_original_not_proven" }, { status: 403 });
      },
    });
    let fixture;
    try {
      const bootstrap = await createFixtureBootstrap(copy, join(root, "scratch"));
      fixture = await bootstrap(await address(callback), Date.now() + 60_000);
      expect(await fixture.assertCurrent()).toBe(true);
      expect(fixture.descriptor.process.pid).toBe(fixture.child.pid);
      const file = join(fixture.descriptor.root, "builtin/tracker.json"),
        before = await readFile(file);
      const input = {
        ticketId: randomUUID(),
        requestId: randomUUID(),
        receiptId: randomUUID(),
        claimId: randomUUID(),
        bindingHash: "a".repeat(64),
      };
      // The worker's native caller observation has a fixed bound, and its first
      // one also starts the helper. A miss refuses before the host callback and
      // reserves nothing, so only a read that never reached the callback is resent.
      const read = async () => {
        const before = callbacks;
        for (let attempt = 1; ; attempt++) {
          const response = await fetch(`${fixture!.descriptor.origin}/v1/fixture/reads`, {
            method: "POST",
            body: JSON.stringify(input),
          });
          if (callbacks !== before || attempt === 10) return response.status;
        }
      };
      expect(await read()).toBe(403);
      expect(callbacks).toBe(1);
      expect(callbackPid).toBe(fixture.child.pid);
      expect(await readFile(file)).toEqual(before);
      // A definitive denial does not reserve or write a receipt slot.
      expect(await read()).toBe(403);
      expect(callbacks).toBe(2);
      for (const path of ["/v1/fleet/mcp", "/v1/worker-mcp", "/catalog"])
        expect((await fetch(`${fixture.descriptor.origin}${path}`, { method: "POST" })).status).toBe(404);
      await expect(
        runFixtureAdmission(
          [
            "read",
            "--ticket-id",
            input.ticketId,
            "--request-id",
            input.requestId,
            "--receipt-id",
            input.receiptId,
            "--claim-id",
            input.claimId,
            "--binding",
            input.bindingHash,
          ],
          { repoRoot: "/must-not-discover-installed-links" },
        ),
      ).rejects.toThrow("Pinned --fixture");
      const flags = [
        "read",
        "--fixture",
        join(fixture.descriptor.root, "fixture.json"),
        "--ticket-id",
        input.ticketId,
        "--request-id",
        input.requestId,
        "--receipt-id",
        input.receiptId,
        "--claim-id",
        input.claimId,
        "--binding",
        input.bindingHash,
        "--url",
        "http://127.0.0.1:4310",
      ];
      await expect(
        runFixtureAdmission(flags, { repoRoot: "/must-not-discover-installed-links" }),
      ).rejects.toThrow();
      await writeFile(join(fixture.descriptor.root, "native-process-proof"), "changed helper bytes");
      expect(await fixture.assertCurrent()).toBe(false);
      expect(
        (
          await fetch(`${fixture.descriptor.origin}/v1/fixture/reads`, {
            method: "POST",
            body: JSON.stringify({ ...input, receiptId: randomUUID() }),
          })
        ).status,
      ).toBe(403);
      expect(callbacks).toBe(2);
      await fixture.close();
      expect(fixture.child.exitCode !== null || fixture.child.signalCode !== null).toBe(true);
      expect(await fixture.assertCurrent()).toBe(false);
      await expect(readFile(join(fixture.descriptor.root, "credentials.json"))).rejects.toMatchObject({
        code: "ENOENT",
      });
    } finally {
      if (fixture) await fixture.close();
      await close(callback);
      await rm(root, { recursive: true, force: true });
    }
  },
);

it("changing both artifact and manifest after host construction cannot select new trusted bytes", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "fixture-artifact-pin-")));
  const { copy } = await privateRepoCopy(root),
    scratch = join(root, "scratch");
  const manifestPath = join(copy, ".local/fixture-read/manifest.json");
  const artifactPath = join(copy, ".local/fixture-read/worker.mjs");
  const manifest = await readFile(manifestPath);
  try {
    const bootstrap = await createFixtureBootstrap(copy, scratch);
    const replacement = Buffer.from("throw new Error('untrusted replacement');\n");
    const changed = JSON.parse(manifest.toString());
    changed.artifactSha256 = createHash("sha256").update(replacement).digest("hex");
    await writeFile(artifactPath, replacement);
    await writeFile(manifestPath, JSON.stringify(changed));
    await expect(bootstrap("http://127.0.0.1:19999", Date.now() + 60_000)).rejects.toThrow(
      "Pinned fixture artifact changed",
    );
    expect((await readdir(root)).sort()).toEqual(["pnpm-store", "repo"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it("only a pnpm store link may give a pinned file a second name; every other trust check still refuses", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "fixture-input-links-")));
  // A shared scratch parent fails the first step after the pins are rechecked, so a case
  // that reaches it passed every pin without launching a fixture.
  const pinsHeld = "Private owned fixture parent required",
    unavailable = "Trusted fixture artifact unavailable at host startup";
  const attempt = async (
    name: string,
    change?: (copy: string, store: string, inputs: string[]) => Promise<unknown>,
  ) => {
    const { copy, store, inputs } = await privateRepoCopy(join(root, name));
    await change?.(copy, store, inputs);
    const scratch = join(root, name, "scratch");
    await mkdir(scratch);
    await chmod(scratch, 0o770);
    const bootstrap = await createFixtureBootstrap(copy, scratch);
    const run = () => bootstrap("http://127.0.0.1:19999", Date.now() + 60_000);
    return { copy, store, inputs, run };
  };
  const firstParty = (inputs: string[]) => inputs.find((path) => path.startsWith("apps/clankie/src/"))!;
  const dependency = (inputs: string[]) => inputs.find(pnpmStoreInput)!;
  try {
    await expect((await attempt("store-links")).run()).rejects.toThrow(pinsHeld);
    // A second name anywhere else is still refused: first-party source, the artifact, its
    // manifest and the helper the host executes.
    for (const [name, target] of [
      ["source", (_: string, inputs: string[]) => firstParty(inputs)],
      ["artifact", () => ".local/fixture-read/worker.mjs"],
      ["manifest", () => ".local/fixture-read/manifest.json"],
      ["helper", (copy: string) => relative(copy, fleetProcessHelper(copy))],
    ] as const) {
      const linked = await attempt(name, (copy, store, inputs) =>
        link(join(copy, target(copy, inputs)), join(store, `${name}-alias`)),
      );
      await expect(linked.run(), name).rejects.toThrow(unavailable);
    }
    // A store link is no exemption from ownership and writability.
    const writable = await attempt("writable", (copy, _, inputs) =>
      chmod(join(copy, dependency(inputs)), 0o664),
    );
    await expect(writable.run()).rejects.toThrow(unavailable);
    // Writing the store copy changes the linked input, and the pin sees it after startup.
    const rewritten = await attempt("rewritten");
    const stored = join(rewritten.store, dependency(rewritten.inputs));
    await chmod(stored, 0o644);
    await writeFile(stored, "export const changed = true;\n");
    await expect(rewritten.run()).rejects.toThrow("Pinned fixture source changed after host startup");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
