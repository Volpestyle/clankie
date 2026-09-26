import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { parseBodyTelemetryLine } from "../src/body-telemetry.ts";

const SCRIPT = resolve(import.meta.dirname, "../../../scripts/release/hosted-body.sh");

/** Runs the whole-body loop with stub `clankie` and `curl`, one failed health check, then stops it. */
async function runBody(telemetryDir: string | undefined, cwd = tmpdir()): Promise<void> {
  const bin = mkdtempSync(join(tmpdir(), "hosted-body-bin-"));
  writeFileSync(join(bin, "clankie"), "#!/bin/sh\nexit 0\n");
  // First probe fails, later ones pass.
  writeFileSync(
    join(bin, "curl"),
    `#!/bin/sh\n[ -e "${bin}/probed" ] && exit 0\ntouch "${bin}/probed"\nexit 7\n`,
  );
  chmodSync(join(bin, "clankie"), 0o755);
  chmodSync(join(bin, "curl"), 0o755);
  const child = spawn("sh", [SCRIPT], {
    env: {
      PATH: `${bin}:${process.env.PATH ?? ""}`,
      CLANKIE_BODY_CHECK_SECONDS: "0.2",
      ...(telemetryDir === undefined ? {} : { CLANKIE_BODY_TELEMETRY_DIR: telemetryDir }),
    },
    cwd,
    stdio: "ignore",
  });
  const exited = new Promise<number | null>((done) => child.once("exit", (code) => done(code)));
  for (let waited = 0; waited < 5_000 && !existsSync(join(bin, "probed")); waited += 50) {
    await new Promise((wake) => setTimeout(wake, 50));
  }
  await new Promise((wake) => setTimeout(wake, 300));
  child.kill("SIGTERM");
  expect(await exited).toBe(0);
}

describe("the whole-body loop's telemetry", () => {
  it("writes only schema-valid lines for boot, restart and shutdown", async () => {
    const dir = mkdtempSync(join(tmpdir(), "hosted-body-spool-"));
    await runBody(dir);
    const lines = readdirSync(dir).flatMap((name) =>
      readFileSync(join(dir, name), "utf8")
        .split("\n")
        .filter((line) => line.length > 0),
    );
    const events = lines.map((line) => parseBodyTelemetryLine(line));
    expect(events.every((event) => event !== undefined)).toBe(true);
    expect(
      events.map((event) =>
        event?.event === "body.boot"
          ? event.phase
          : event?.event === "body.service"
            ? event.state
            : event?.event,
      ),
    ).toEqual(["container-start", "clankie-healthy", "restarting", "healthy", "body.shutdown"]);
    expect(readdirSync(dir)[0]).toMatch(/^\d{10}-body\.jsonl$/u);
  }, 15_000);

  it("writes nothing when the host names no spool", async () => {
    const scratch = mkdtempSync(join(tmpdir(), "hosted-body-off-"));
    await runBody(undefined, scratch);
    expect(readdirSync(scratch)).toEqual([]);
  }, 15_000);
});
