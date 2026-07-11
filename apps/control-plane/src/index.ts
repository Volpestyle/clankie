import { serve } from "@hono/node-server";
import { createLogger } from "@sapling/observability";
import { createControlPlane, loadDefaultDoctrine } from "./app.ts";

const logger = createLogger({ service: "sapling-control-plane", version: "0.1.0" });
const doctrine = await loadDefaultDoctrine();
const app = createControlPlane({ doctrine });
const port = Number(process.env.PORT ?? 4310);
serve({ fetch: app.fetch, port });
logger.info({ port, profileHash: doctrine.profileHash }, "control plane listening");
