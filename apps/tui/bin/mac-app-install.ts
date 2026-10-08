/** Bundled bootstrap, invoked by install.sh with the release's own Node runtime. */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { prepareMacApp, launchMacApp } from "./mac-app.ts";

const [root, installRoot, action] = process.argv.slice(2);
if (!root || !installRoot || !["install", "no-app", "launch"].includes(action ?? ""))
  throw Error("Invalid app installer arguments");
try {
  if (action === "launch") {
    const paired = await launchMacApp(
      root,
      join(process.env.CLANKIE_APPLICATIONS_DIR ?? "/Applications", "Clankie.app"),
      process.env,
    );
    console.log(
      paired
        ? "Clankie.app opened with a private pairing handoff."
        : "Clankie.app pairing pending; run clankie pair --local-companion, then open the app.",
    );
  } else {
    mkdirSync(installRoot, { recursive: true });
    writeFileSync(
      join(installRoot, "app-policy.json"),
      JSON.stringify({ disabled: action === "no-app" }) + "\n",
    );
    const app = await prepareMacApp(root, installRoot, {
      target: "darwin-arm64",
      applicationsDirectory: process.env.CLANKIE_APPLICATIONS_DIR,
    });
    if (app) {
      try {
        app.activate();
        app.finish();
      } catch (error) {
        app.rollback();
        throw error;
      }
      console.log("Clankie.app installed from its verified release pin.");
    } else console.log("Clankie.app skipped (opt-out or no published pin).");
  }
} catch {
  console.error(
    "Clankie.app install failed; existing app retained. Inspect the release pin and destination.",
  );
  process.exitCode = 1;
}
