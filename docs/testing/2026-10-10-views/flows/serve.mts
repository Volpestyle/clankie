// A throwaway instance of the real view routes and store (VUH-2035), so the
// proof runs `clankie view` end to end without restarting the owner's service.
// Both sources read the owner's running service as the owner, read-only: the
// machine's live fleet-resources snapshot and its `/v1/work` list. Run from
// apps/clankie so workspace packages resolve.
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serve } from "@hono/node-server";
import { resolveOperatorCredential } from "@clankie/credential-broker";
import { FLEET_RESOURCES_PATH } from "@clankie/protocol";
import { createViewRoutes } from "../../../../apps/clankie/src/view-routes.ts";
import { ViewStore } from "../../../../apps/clankie/src/views.ts";

const live = process.env.LIVE_SERVICE ?? "http://127.0.0.1:4310";
const port = Number(process.env.PORT ?? "4399");
const credential = await resolveOperatorCredential({ env: process.env });
if (!credential) throw new Error("No owner operator credential");
const owner = { authorization: `Bearer ${credential.token}`, "content-type": "application/json" };

// The service's resource runtime caches its snapshot; mirror that with a 2s poll.
let snapshot: unknown;
const poll = async () => {
  const response = await fetch(new URL(FLEET_RESOURCES_PATH, live), { headers: owner });
  if (response.ok) snapshot = await response.json();
};
await poll();
setInterval(() => void poll().catch(() => undefined), 2_000);

const routes = createViewRoutes(
  async (request) => (request.headers.get("authorization") === owner.authorization ? true : "forbidden"),
  new ViewStore(await mkdtemp(join(tmpdir(), "views-proof-"))),
  {
    fleetResources: () => snapshot,
    listIssues: async (request) => {
      const response = await fetch(new URL("/v1/work", live), {
        method: "POST",
        headers: owner,
        body: JSON.stringify(request),
      });
      const body = (await response.json()) as { detail?: string };
      if (!response.ok) throw new Error(body.detail ?? `work list failed (${String(response.status)})`);
      return body;
    },
  },
);
serve({ fetch: routes.fetch, port, hostname: "127.0.0.1" });
console.log(`views proof service on http://127.0.0.1:${String(port)}`);
