// One hiring controller in its own process, claiming a deliverable at a shared instant (#602).
import { readFileSync } from "node:fs";
import { ProjectsSettingsSchema } from "@clankie/protocol/projects";
import { ProjectHires } from "../../src/captain/project-hires.ts";

const [path, settingsPath, workingDirectory, deliverable, startAt] = process.argv.slice(2);
const settings = ProjectsSettingsSchema.parse(JSON.parse(readFileSync(settingsPath!, "utf8")));
while (Date.now() < Number(startAt)) {
  /* Spin to the shared start so every racer reaches the ledger together. */
}
// A busy ledger is a retry, as a lead would retry it; the answer that counts is a claim or a refusal.
for (let tries = 0; ; tries++) {
  try {
    const claim = new ProjectHires(path!).reserve(settings, "game", {
      schemaVersion: 1,
      harness: "claude",
      title: "Racer",
      workingDirectory: workingDirectory!,
      deliverable: deliverable!,
    });
    process.stdout.write(JSON.stringify({ claimed: claim.id, tries }));
    break;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!/Project hiring is busy/u.test(message) || tries >= 500) {
      process.stdout.write(JSON.stringify({ refused: message, tries }));
      break;
    }
    const until = Date.now() + 1 + Math.floor(Math.random() * 5);
    while (Date.now() < until) {
      /* Back off briefly before the next look. */
    }
  }
}
