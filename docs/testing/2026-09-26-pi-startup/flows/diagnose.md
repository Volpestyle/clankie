# Baseline diagnosis source

Used with the pre-fix bundled Herdr runner. Runs eight starts with the original
5-second process timeout and observes the same pi process afterward.

```js
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdirSync, writeFileSync, statSync } from "node:fs";
import { createHerdrWatchRunner } from "./herdr-watch.mjs";
const exec = promisify(execFile);
const runner = createHerdrWatchRunner();
mkdirSync("/state/home/.pi/agent", { recursive: true });
writeFileSync(
  "/state/home/.pi/agent/models.json",
  JSON.stringify({
    providers: {
      proof: {
        baseUrl: "http://127.0.0.1:18081/v1",
        api: "openai-completions",
        apiKey: "synthetic",
        models: [{ id: "pi-worker" }],
      },
    },
  }),
);
writeFileSync(
  "/state/home/.pi/agent/settings.json",
  JSON.stringify({ defaultProvider: "proof", defaultModel: "pi-worker" }),
);
await runner.installPiIntegration();
for (let i = 1; i <= 8; i++) {
  const paneId = await runner.createTab({ cwd: "/workspace", label: `diagnose-${i}` });
  const started = Date.now();
  let outcome;
  try {
    await exec("herdr", ["agent", "start", `diagnose-${i}`, "--kind", "pi", "--pane", paneId], {
      timeout: 5000,
    });
    outcome = { start: "resolved", startMs: Date.now() - started };
  } catch (e) {
    outcome = {
      start: "failed",
      startMs: Date.now() - started,
      killed: e.killed,
      signal: e.signal,
      code: e.code,
      stderr: e.stderr,
      message: e.message,
    };
  }
  let snapshot;
  while (Date.now() - started < 35000) {
    try {
      snapshot = await runner.get(paneId);
    } catch {}
    if (snapshot?.agent === "pi" && snapshot.session && ["idle", "done"].includes(snapshot.status)) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  console.log(
    JSON.stringify({
      i,
      paneId,
      ...outcome,
      observedMs: Date.now() - started,
      snapshot,
      sessionFileExists:
        snapshot?.session?.kind === "path"
          ? !!statSync(snapshot.session.value, { throwIfNoEntry: false })
          : undefined,
    }),
  );
  await runner.closePane(paneId);
}
```
