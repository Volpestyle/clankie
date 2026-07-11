import { resolve } from "node:path";
import { serve } from "@hono/node-server";
import { SqliteEventStore } from "@sapling/event-store";
import { createLogger } from "@sapling/observability";
import { createBearerAuthenticator, createControlPlane, loadDefaultDoctrine } from "./app.ts";

const logger = createLogger({ service: "sapling-control-plane", version: "0.1.0" });
const doctrine = await loadDefaultDoctrine();
const eventStorePath = resolve(process.env.SAPLING_EVENT_STORE ?? "artifacts/control-plane/events.db");
const eventStore = new SqliteEventStore(eventStorePath);
const runnerToken = process.env.SAPLING_RUNNER_TOKEN;
const captainToken = process.env.SAPLING_CAPTAIN_TOKEN;
const runnerId = process.env.SAPLING_RUNNER_ID ?? "local";
const app = await createControlPlane({
  doctrine,
  eventStore,
  ...(process.env.SAPLING_REPO_PATH ? { workspacePath: process.env.SAPLING_REPO_PATH } : {}),
  ...(runnerToken
    ? {
        authenticateRunner: createBearerAuthenticator(runnerToken, { runnerId }),
      }
    : {}),
  ...(captainToken
    ? {
        authenticateCaptain: createBearerAuthenticator(captainToken, {
          captainId: "captain-eve",
        }),
      }
    : {}),
});
const port = Number(process.env.PORT ?? 4310);
serve({ fetch: app.fetch, port });
logger.info({ port, profileHash: doctrine.profileHash, eventStorePath }, "control plane listening");
