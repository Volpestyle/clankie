import { resolve } from "node:path";
import { serve } from "@hono/node-server";
import { SqliteEventStore } from "@sapling/event-store";
import { createLogger } from "@sapling/observability";
import { createControlPlane, loadDefaultDoctrine } from "./app.ts";

const logger = createLogger({ service: "sapling-control-plane", version: "0.1.0" });
const doctrine = await loadDefaultDoctrine();
const eventStorePath = resolve(process.env.SAPLING_EVENT_STORE ?? "artifacts/control-plane/events.db");
const eventStore = new SqliteEventStore(eventStorePath);
const app = await createControlPlane({ doctrine, eventStore });
const port = Number(process.env.PORT ?? 4310);
serve({ fetch: app.fetch, port });
logger.info({ port, profileHash: doctrine.profileHash, eventStorePath }, "control plane listening");
