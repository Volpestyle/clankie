import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { createClankieApp } from "../../clankie/src/app.ts";
import { createStubCaptain } from "../../clankie/src/captain/port.ts";
import { createWorkItemsService } from "../../clankie/src/work-items.ts";
import { runWorkCommand } from "../src/command/work.ts";

const roots: string[] = [];
const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(
    servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
  );
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

it("writes through the CLI, owner HTTP route and files, then reconciles a lost response without replay", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "work-write-cli-")));
  roots.push(root);
  const state = join(root, "state");
  await mkdir(join(root, ".clankie"), { recursive: true });
  await mkdir(join(root, "tasks"));
  await writeFile(
    join(root, ".clankie/tracking.json"),
    JSON.stringify({
      schemaVersion: 1,
      backend: "markdown",
      directory: "tasks",
      decidedBy: "owner",
      decidedAt: "2026-10-04T00:00:00Z",
    }),
  );
  const itemPath = join(root, "tasks/T-1-cli.md");
  await writeFile(
    itemPath,
    '---\nid: T-1\ntitle: CLI item\nstatus: todo\nparent: T-0\nlabels: ["a,b", builder]\ndepends_on: T-2\n---\n\nKeep this text.\n',
  );
  const work = createWorkItemsService({ stateDirectory: state, workspace: () => root });
  const { app } = await createClankieApp({
    captain: createStubCaptain(),
    workItems: work,
    authenticateOperator: async (request) =>
      request.headers.get("authorization") === "Bearer cli-owner" ? { operatorId: "cli-owner" } : undefined,
  });
  let loseResponse = false;
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = Buffer.concat(chunks).toString("utf8");
    const result = await app.request(request.url!, {
      method: request.method ?? "POST",
      headers: {
        authorization: String(request.headers.authorization ?? ""),
        "content-type": "application/json",
      },
      body,
    });
    const output = await result.text();
    if (loseResponse && JSON.parse(body).action === "write") {
      response.destroy();
      return;
    }
    response.writeHead(result.status, { "content-type": "application/json" });
    response.end(output);
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing CLI fixture address");
  const env = {
    CLANKIE_OPERATOR_TOKEN: "cli-owner",
    CLANKIE_CONTROL_PLANE_URL: `http://127.0.0.1:${address.port}`,
  };
  const command = (args: string[]) => runWorkCommand(args, { env, cwd: root });
  const assigned = await command(["write", "T-1", "--owner", "Sol"]);
  expect(assigned, JSON.stringify(assigned)).toMatchObject({
    ok: true,
    body: { outcome: "applied", item: { owner: "Sol", parent: "T-0" } },
  });
  expect(await command(["write", "T-1", "--add-label", "designer"])).toMatchObject({
    ok: true,
    body: { item: { labels: ["a,b", "builder", "designer"] } },
  });
  expect(await command(["write", "T-1", "--remove-label", "BUILDER"])).toMatchObject({
    ok: true,
    body: { item: { labels: ["a,b", "designer"] } },
  });
  const requestId = randomUUID();
  loseResponse = true;
  const lost = await command(["write", "T-1", "--add-blocker", "T-3", "--request-id", requestId]);
  expect(lost).toMatchObject({ ok: false, body: { requestId, outcome: "uncertain" } });
  const published = await readFile(itemPath, "utf8");
  expect(published).toContain("depends_on: T-2, T-3");
  loseResponse = false;
  expect(await command(["receipt", "T-1", "--request-id", requestId])).toMatchObject({
    ok: true,
    body: { requestId, outcome: "applied", item: { dependsOn: ["T-2", "T-3"] } },
  });
  expect(await command(["write", "T-1", "--add-blocker", "T-3", "--request-id", requestId])).toMatchObject({
    ok: true,
    body: { requestId, outcome: "applied" },
  });
  expect(await readFile(itemPath, "utf8")).toBe(published);
  expect(await command(["write", "T-1", "--owner", "Other", "--request-id", requestId])).toMatchObject({
    ok: false,
    body: { outcome: "refused" },
  });
  expect(await readFile(itemPath, "utf8")).toBe(published);
});
