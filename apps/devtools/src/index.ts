import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { JsonlEventStore } from "@clankie/event-store";
import { projectGarden } from "@clankie/garden-model";
import { DomainEventSchema } from "@clankie/protocol";
import { statusExplain } from "./status.ts";

const [command = "help", ...arguments_] = process.argv.slice(2);
const path = arguments_[0];
const invocationDirectory = process.env.INIT_CWD ?? process.cwd();

if (command === "audit" && path) {
  const result = await new JsonlEventStore(resolve(invocationDirectory, path)).verify();
  console.log(JSON.stringify(result, null, 2));
  process.exitCode = result.valid ? 0 : 1;
} else if ((command === "timeline" || command === "garden") && path) {
  const events = await readDomainEvents(resolve(invocationDirectory, path));
  if (command === "garden") {
    console.log(JSON.stringify(projectGarden(events), null, 2));
  } else {
    for (const event of events) {
      const identity = [event.missionId, event.taskId, event.workerRunId].filter(Boolean).join("/");
      console.log(`${event.occurredAt}  ${event.type.padEnd(32)}  ${identity}`);
    }
  }
} else if (command === "status" && arguments_[0] === "explain" && arguments_[1] && arguments_[2]) {
  const events = await readDomainEvents(resolve(invocationDirectory, arguments_[2]));
  console.log(statusExplain(events, arguments_[1]));
} else {
  console.log(
    `Usage:\n  pnpm --filter @clankie/devtools dev timeline <domain-events.jsonl>\n  pnpm --filter @clankie/devtools dev garden <domain-events.jsonl>\n  pnpm --filter @clankie/devtools dev audit <hash-chained-store.jsonl>\n  pnpm --filter @clankie/devtools dev status explain <workerRunId|captain> <domain-events.jsonl>`,
  );
}

async function readDomainEvents(path: string) {
  const raw = await readFile(path, "utf8");
  return raw
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => DomainEventSchema.parse(JSON.parse(line)));
}
