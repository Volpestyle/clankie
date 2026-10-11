import { createServer } from "node:net";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { parseEnv } from "node:util";
import { fileURLToPath } from "node:url";

if (process.argv[2] === "run") {
  const service = process.argv[4];
  if (service !== "clankie" && service !== "relay") throw new Error("Expected run DIRECTORY clankie|relay");
  const env = parseEnv(await readFile(join(resolve(process.argv[3]), "stack.env"), "utf8"));
  const root = fileURLToPath(new URL("../", import.meta.url));
  const child = spawn(
    process.execPath,
    [
      "--import",
      join(root, `apps/${service}/node_modules/tsx/dist/loader.mjs`),
      join(root, `apps/${service}/src/index.ts`),
    ],
    { cwd: root, env: { PATH: process.env.PATH, LANG: process.env.LANG, ...env }, stdio: "inherit" },
  );
  for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => child.kill(signal));
  child.on("error", (error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
  child.on("exit", (code) => {
    process.exitCode = code ?? 1;
  });
} else {
  // Produce one preset for both processes. Hold selections until all are chosen;
  // a subsequent bind race must fail, never fall back to a live port.
  const directory = resolve(process.argv[2] ?? `.local/scratch-${Date.now()}`);
  if (/['\r\n]/u.test(directory)) throw new Error("Scratch directory cannot contain quotes or newlines");
  const reservations = [];
  async function freePort() {
    for (;;) {
      const server = createServer();
      await new Promise((done, fail) => {
        server.once("error", fail);
        server.listen(0, "127.0.0.1", done);
      });
      const port = server.address().port;
      if (port === 4310 || port === 4321) {
        await new Promise((done) => server.close(done));
        continue;
      }
      reservations.push(server);
      return port;
    }
  }
  try {
    const captain = await freePort();
    const relay = await freePort();
    const device = await freePort();
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const home = join(directory, "home");
    await mkdir(home, { recursive: true, mode: 0o700 });
    await writeFile(
      join(directory, "settings.json"),
      JSON.stringify({
        schemaVersion: 1,
        herdr: { runtime: "disabled" },
        captain: { workingDirectory: directory },
      }),
      { mode: 0o600, flag: "wx" },
    );
    const env = {
      HOME: home,
      CLANKIE_SCRATCH: "1",
      CLANKIE_STATE: join(directory, "state"),
      CLANKIE_SETTINGS_FILE: join(directory, "settings.json"),
      CLANKIE_CREDENTIALS_FILE: join(directory, "credentials.json"),
      CLANKIE_BROWSER_ENABLED: "false",
      XDG_CONFIG_HOME: join(directory, "config"),
      PORT: String(captain),
      CLANKIE_RELAY_PORT: String(relay),
      CLANKIE_DEVICE_PORT: String(device),
      CLANKIE_CAPTAIN_URL: `http://127.0.0.1:${captain}`,
      CLANKIE_CONTROL_PLANE_URL: `http://127.0.0.1:${captain}`,
      CLANKIE_RELAY_URL: `http://127.0.0.1:${relay}`,
      CLANKIE_CAPTAIN_TOKEN: randomBytes(32).toString("hex"),
      CLANKIE_OPERATOR_TOKEN: randomBytes(32).toString("hex"),
    };
    // Node's --env-file accepts quoted values. Never source generated paths as shell code.
    await writeFile(
      join(directory, "stack.env"),
      Object.entries(env)
        .map(([name, value]) => `${name}='${value}'`)
        .join("\n") + "\n",
      { mode: 0o600, flag: "wx" },
    );
    console.log(join(directory, "stack.env"));
  } finally {
    await Promise.all(reservations.map((server) => new Promise((done) => server.close(done))));
  }
}
