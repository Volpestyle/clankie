import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { FileCredentialStore } from "@clankie/credential-broker";
import { resolveSeatContext } from "../../../tui/src/command/seat-context.ts";
import { runSeatDeliveryCommand } from "../../../tui/src/command/seat-delivery.ts";
import { runAgentsCommand } from "../../../tui/src/command/agents.ts";

const [denied, deliveryId] = process.argv.slice(2);
assert(denied && deliveryId);
await assert.rejects(readFile(denied)); // Prove the disposable OS profile is active.
const store = new FileCredentialStore(denied);
let reads = 0;
const original = store.get.bind(store);
store.get = (provider) => {
  reads += 1;
  return original(provider);
};
await assert.rejects(
  resolveSeatContext(
    { cwd: process.cwd(), command: "codex", dryRun: true },
    {
      repoRoot: process.cwd(),
      env: process.env,
      operatorCredentialStore: store,
    },
  ),
  { code: "worker_pane" },
);
await assert.rejects(
  runSeatDeliveryCommand(["list"], {
    env: process.env,
    captainCredentialStore: store,
  }),
  { code: "worker_pane" },
);
const result = await runAgentsCommand(["message-status", deliveryId], {
  env: process.env,
  operatorCredentialStore: store,
});
assert.equal((result as { deliveryStage: string }).deliveryStage, "consumed");
assert.equal(reads, 0);
console.log("sandbox active; owner-seat commands refused; pane receipt readable; zero broker reads");
