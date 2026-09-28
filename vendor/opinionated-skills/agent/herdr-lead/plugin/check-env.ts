import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "hl-check-"));
process.on("exit", () => fs.rmSync(tmp, { recursive: true, force: true }));
const root = path.join(tmp, "root");
fs.mkdirSync(root, { recursive: true });
process.env.HERDR_PLUGIN_STATE_DIR = path.join(tmp, "state");
process.env.HERD_LEAD_ROOT = root;
process.env.HERD_LEAD_LINEAR_TEAMS = "ABC,XY,A+B";
process.env.HERD_LEAD_LINEAR_URL = "https://linear.app/test";
