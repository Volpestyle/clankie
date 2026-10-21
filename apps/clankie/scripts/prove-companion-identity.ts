/**
 * Manual real-dependency proof for VUH-2604 on macOS: the same-Mac companion
 * handoff goes only to an app whose running code satisfies an owner-trusted
 * requirement. Run through clankie heavy --server; it starts a private scratch
 * service and never touches the installed Clankie.app, ~/.clankie or its pairing.
 */
import assert from "node:assert/strict";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { appendFileSync, readFileSync } from "node:fs";
import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parseEnv } from "node:util";
import { setTimeout as delay } from "node:timers/promises";

assert.equal(process.platform, "darwin", "The companion handoff exists only on macOS");
const repo = resolve(import.meta.dirname, "../../..");
const root = resolve(process.argv[2] ?? join(repo, ".local/vuh-2604", `proof-${Date.now()}`));
const results: { steps: { name: string; detail: unknown }[]; outcome?: string; error?: string } = {
  steps: [],
};
const step = (name: string, detail: unknown = {}) => {
  console.log(`✓ ${name}`);
  results.steps.push({ name, detail });
};

execFileSync(
  process.execPath,
  [join(repo, "scripts/scratch-stack.mjs"), join(root, "stack"), "--broker-operator"],
  {
    cwd: repo,
  },
);
const stackDir = join(root, "stack");
const env = parseEnv(await readFile(join(stackDir, "stack.env"), "utf8")) as Record<string, string>;
assert(env.CLANKIE_STATE!.startsWith(root), "the proof service keeps its own state");
const url = env.CLANKIE_CAPTAIN_URL!;

// Two native apps from one source: the protocol is identical, only the signed identity differs.
const source = join(root, "companion.swift");
await writeFile(
  source,
  `import Foundation
let arguments = CommandLine.arguments
let handoff = try! JSONSerialization.jsonObject(with: Data(contentsOf: URL(fileURLWithPath: arguments[1]))) as! [String: Any]
let origin = (handoff["controlPlaneUrl"] as! String).trimmingCharacters(in: CharacterSet(charactersIn: "/"))
var request = URLRequest(url: URL(string: origin + "/v1/pairing/local/redeem")!)
request.httpMethod = "POST"
request.setValue("application/json", forHTTPHeaderField: "Content-Type")
request.httpBody = try! JSONSerialization.data(withJSONObject: ["offerSecret": handoff["offerSecret"]!])
let done = DispatchSemaphore(value: 0)
var result = ""
URLSession.shared.dataTask(with: request) { data, response, error in
  let status = (response as? HTTPURLResponse)?.statusCode ?? -1
  result = "\\(status)\\n" + (data.flatMap { String(data: $0, encoding: .utf8) } ?? String(describing: error))
  done.signal()
}.resume()
done.wait()
try! result.write(toFile: arguments[2], atomically: true, encoding: .utf8)
`,
);
const binary = join(root, "companion");
execFileSync("xcrun", ["swiftc", "-O", "-o", binary, source]);
// The impostor's code differs (an unoptimized build of the same source).
const impostorBinary = join(root, "companion-impostor");
execFileSync("xcrun", ["swiftc", "-Onone", "-o", impostorBinary, source]);
async function bundle(name: string, identifier: string, folder = name, executable = binary): Promise<string> {
  const app = join(root, `${folder}.app`);
  await mkdir(join(app, "Contents/MacOS"), { recursive: true });
  await cp(executable, join(app, "Contents/MacOS", name));
  await writeFile(
    join(app, "Contents/Info.plist"),
    `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>${identifier}</string>
<key>CFBundleExecutable</key><string>${name}</string>
<key>CFBundleName</key><string>${name}</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>LSBackgroundOnly</key><true/>
</dict></plist>
`,
  );
  execFileSync("codesign", ["--force", "--sign", "-", app]);
  execFileSync("codesign", ["--verify", "--strict", app]);
  return app;
}
const trustedApp = await bundle("TrustedCompanion", "io.clankie.proof.vuh2604.trusted");
const rogueApp = await bundle("RogueCompanion", "io.clankie.proof.vuh2604.rogue");
// The same identifier, different code: an impostor that claims the trusted bundle id.
const impostorApp = await bundle(
  "TrustedCompanion",
  "io.clankie.proof.vuh2604.trusted",
  "Impostor",
  impostorBinary,
);
assert.notEqual(describe(impostorApp).cdhash, describe(trustedApp).cdhash);
step("built three ad-hoc signed apps", {
  trusted: describe(trustedApp),
  rogue: describe(rogueApp),
  impostor: describe(impostorApp),
});
function describe(app: string) {
  const text = execFileSync("sh", ["-c", `codesign -dv --verbose=4 '${app}' 2>&1`], { encoding: "utf8" });
  return {
    identifier: /^Identifier=(.+)$/mu.exec(text)?.[1],
    cdhash: /^CDHash=(.+)$/mu.exec(text)?.[1],
  };
}

let child: ChildProcess | undefined;
// Pairing guarantees a relay; starting the stack's own first keeps a detached one from outliving the proof.
let relay: ChildProcess | undefined;
const cli = (...args: string[]) =>
  execFileSync(process.execPath, [join(repo, "scripts/scratch-stack.mjs"), "run", stackDir, "cli", ...args], {
    cwd: repo,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
const json = (text: string) => JSON.parse(text.trim().split("\n").at(-1)!);
let attempt = 0;
async function redeem(app: string, executable: string) {
  attempt += 1;
  const out = join(root, `redeem-${attempt}.txt`);
  const handoff = join(env.CLANKIE_STATE!, "companion/companion-offer.json");
  execFileSync(join(app, "Contents/MacOS", executable), [handoff, out]);
  const [status, ...body] = (await readFile(out, "utf8")).split("\n");
  return { status: Number(status), body: JSON.parse(body.join("\n")) as Record<string, unknown> };
}
const events = () =>
  readFileSync(join(env.CLANKIE_STATE!, "events.jsonl"), "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as { type: string; data: Record<string, unknown> });
try {
  child = spawn(
    process.execPath,
    ["--import", join(repo, "scripts/dependency-types.mjs"), join(repo, "apps/clankie/src/index.ts")],
    {
      cwd: repo,
      env: { PATH: process.env.PATH, LANG: process.env.LANG, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  child.stdout?.on("data", (data: Buffer) => appendFileSync(join(root, "service.log"), data));
  child.stderr?.on("data", (data: Buffer) => appendFileSync(join(root, "service.log"), data));
  for (let i = 0; i < 300; i++) {
    const healthy = await fetch(`${url}/health`).then(
      (r) => r.ok,
      () => false,
    );
    const issuer = await readFile(join(env.CLANKIE_STATE!, "companion/companion-issuer.json"), "utf8").then(
      () => true,
      () => false,
    );
    if (healthy && issuer) break;
    await delay(200);
  }
  relay = spawn(process.execPath, [join(repo, "scripts/scratch-stack.mjs"), "run", stackDir, "relay"], {
    cwd: repo,
    stdio: ["ignore", "pipe", "pipe"],
  });
  relay.stdout?.on("data", (data: Buffer) => appendFileSync(join(root, "relay.log"), data));
  relay.stderr?.on("data", (data: Buffer) => appendFileSync(join(root, "relay.log"), data));
  for (let i = 0; i < 150; i++) {
    if (
      await fetch(`${env.CLANKIE_RELAY_URL}/health`).then(
        (r) => r.ok,
        () => false,
      )
    )
      break;
    await delay(200);
  }
  json(cli("pair", "--local-companion", "--json"));

  // Nothing is trusted until the owner says so: the rogue app is refused, and so is
  // every app, while the offer survives for the real one.
  assert.deepEqual(json(cli("companion", "list")), { apps: [] });
  const rogue = await redeem(rogueApp, "RogueCompanion");
  assert.equal(rogue.status, 403);
  assert.deepEqual(rogue.body, { error: "companion_app_untrusted", reason: "untrusted" });
  step("with nothing trusted, a launched app is refused", rogue);

  const trusted = json(cli("companion", "trust", trustedApp, "--label", "Proof companion"));
  assert.equal(trusted.apps.length, 1);
  assert.equal(trusted.apps[0].identifier, "io.clankie.proof.vuh2604.trusted");
  assert.equal(
    json(cli("companion", "trust", trustedApp)).apps.length,
    1,
    "re-trusting the same code adds nothing",
  );
  step("owner trusted one app by its designated requirement", trusted);

  const rogueAgain = await redeem(rogueApp, "RogueCompanion");
  assert.equal(rogueAgain.status, 403);
  const impostor = await redeem(impostorApp, "TrustedCompanion");
  assert.equal(impostor.status, 403);
  assert.equal(impostor.body.reason, "untrusted");
  step("a different bundle and an impostor of the trusted bundle id are both refused", {
    rogue: rogueAgain,
    impostor,
  });

  const accepted = await redeem(trustedApp, "TrustedCompanion");
  assert.equal(accepted.status, 200, JSON.stringify(accepted.body));
  assert.match(String(accepted.body.deviceToken), /\S{20,}/u);
  step("the trusted app takes the handoff after two refusals left the offer intact", {
    status: accepted.status,
    deviceId: accepted.body.deviceId,
  });

  const log = events();
  const refusals = log.filter((event) => event.type === "pairing.local_companion.refused");
  assert.deepEqual(
    refusals.map((event) => (event.data.app as { identifier?: string } | undefined)?.identifier),
    ["io.clankie.proof.vuh2604.rogue", "io.clankie.proof.vuh2604.rogue", "io.clankie.proof.vuh2604.trusted"],
  );
  const activated = log.find((event) => event.type === "device.activated");
  const app = activated?.data.companionApp as { identifier?: string; cdhash?: string; trustedAppId?: string };
  assert.equal(app.identifier, "io.clankie.proof.vuh2604.trusted");
  assert.equal(app.cdhash, describe(trustedApp).cdhash);
  assert.equal(app.trustedAppId, trusted.apps[0].id);
  step("events name every refused app and the app that took the session", { refusals, activated });

  // A team-bound requirement (the shape of a Developer ID release) refuses an ad-hoc build
  // that only claims the right bundle id.
  json(cli("companion", "remove", trusted.apps[0].id));
  cli("pair", "--local-companion", "--json");
  const teamOnly = await fetch(`${url}/v1/pairing/local/trusted-apps`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${JSON.parse(readFileSync(env.CLANKIE_CREDENTIALS_FILE!, "utf8")).clankie_operator.key}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      op: "add",
      app: {
        label: "Release-shaped",
        requirement:
          'anchor apple generic and identifier "io.clankie.proof.vuh2604.trusted" and certificate leaf[subject.OU] = "ABCDE12345"',
        identifier: "io.clankie.proof.vuh2604.trusted",
        teamId: "ABCDE12345",
      },
    }),
  });
  assert.equal(teamOnly.status, 200, await teamOnly.clone().text());
  const unsignedForTeam = await redeem(trustedApp, "TrustedCompanion");
  assert.equal(unsignedForTeam.status, 403);
  step("a team-bound requirement refuses an ad-hoc build claiming the bundle id", unsignedForTeam);
  results.outcome = "passed";
} catch (error) {
  results.outcome = "failed";
  results.error = String((error as Error).stack ?? error);
  throw error;
} finally {
  child?.kill("SIGTERM");
  relay?.kill("SIGTERM");
  await delay(1000);
  if (child?.exitCode === null) child.kill("SIGKILL");
  if (relay?.exitCode === null) relay.kill("SIGKILL");
  await writeFile(join(root, "result.json"), JSON.stringify(results, null, 2));
  console.log(`result: ${join(root, "result.json")} (${results.outcome})`);
}
