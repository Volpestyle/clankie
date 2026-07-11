import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { JsonlEventStore } from "@sapling/event-store";
import { projectGarden } from "@sapling/garden-model";
import { DomainEventSchema } from "@sapling/protocol";

const [command = "help", path] = process.argv.slice(2);

if (command === "audit" && path) {
  const result = await new JsonlEventStore(resolve(path)).verify();
  console.log(JSON.stringify(result, null, 2));
  process.exitCode = result.valid ? 0 : 1;
} else if ((command === "timeline" || command === "garden") && path) {
  const events = await readDomainEvents(resolve(path));
  if (command === "garden") {
    console.log(JSON.stringify(projectGarden(events), null, 2));
  } else {
    for (const event of events) {
      const identity = [event.missionId, event.taskId, event.workerRunId].filter(Boolean).join("/");
      console.log(`${event.occurredAt}  ${event.type.padEnd(32)}  ${identity}`);
    }
  }
} else {
  console.log(
    `Usage:\n  pnpm --filter @sapling/devtools dev timeline <domain-events.jsonl>\n  pnpm --filter @sapling/devtools dev garden <domain-events.jsonl>\n  pnpm --filter @sapling/devtools dev audit <hash-chained-store.jsonl>`,
  );
}

async function readDomainEvents(path: string) {
  const raw = await readFile(path, "utf8");
  return raw
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => DomainEventSchema.parse(JSON.parse(line)));
}
