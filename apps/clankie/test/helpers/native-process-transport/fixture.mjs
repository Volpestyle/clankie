// Executed as a real child through the production transport. No mocked process/pipe APIs.
import { spawn } from "node:child_process";
import { appendFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
const root = dirname(fileURLToPath(import.meta.url));
const log = (record) =>
  appendFileSync(join(root, "journal.jsonl"), JSON.stringify({ ...record, pid: process.pid }) + "\n");
log({ kind: "start", argv: process.argv.slice(2) });
let sequence = 0;
const reply = (id, mode) => ({
  id,
  ok: true,
  result: { pid: process.pid, mode, sequence: ++sequence },
  stderr: "",
});
const send = (value) => process.stdout.write(JSON.stringify(value) + "\n");
for await (const line of createInterface({ input: process.stdin })) {
  const [rawId, mode] = line.split(" ");
  const id = Number(rawId);
  log({ kind: "request", id, mode });
  switch (mode) {
    case "wrong-id":
      send(reply(id + 1, mode));
      break;
    case "extra-frame":
      process.stdout.write(JSON.stringify(reply(id, mode)) + "\n" + JSON.stringify(reply(id, mode)) + "\n");
      break;
    case "oversized":
      process.stdout.write(Buffer.alloc(1_048_577, "x"));
      break;
    case "stderr":
      process.stderr.write("unexpected side channel\n");
      break;
    case "dead":
      process.exit(17);
      break;
    case "exit-with-held-pipes": {
      const holder = spawn(process.execPath, ["-e", "setTimeout(() => process.exit(0), 400)"], {
        stdio: ["ignore", process.stdout, process.stderr],
      });
      holder.once("spawn", () => {
        log({ kind: "holder", holderPid: holder.pid });
        process.exit(17);
      });
      await new Promise(() => {});
      break;
    }
    case "timeout":
      await new Promise(() => {});
      break;
    case "hold": {
      await new Promise((resolve) => {
        const timer = setInterval(() => {
          if (existsSync(join(root, "release"))) {
            clearInterval(timer);
            resolve();
          }
        }, 5);
      });
      send(reply(id, mode));
      break;
    }
    case "refuse":
      send({ id, ok: false, result: null, stderr: "fixed refusal diagnostic\n" });
      break;
    default:
      send(reply(id, mode));
  }
}
