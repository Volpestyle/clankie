import { writeFile, rename } from "node:fs/promises";
import { probeDesktopActorPermissions } from "./desktop-permissions.mjs";

const [output, nonce] = process.argv.slice(2);
if (!output || !nonce || process.argv.length !== 4) throw Error("Invalid diagnostic invocation");
let result;
try {
  result = { state: "observed", observation: await probeDesktopActorPermissions() };
} catch {
  result = {
    state: "unavailable",
    reason: process.platform === "darwin" ? "terminal_context_unavailable" : "unsupported",
  };
}
await writeFile(`${output}.tmp`, JSON.stringify({ nonce, result }), { flag: "wx", mode: 0o600 });
await rename(`${output}.tmp`, output);
