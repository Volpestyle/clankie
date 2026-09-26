// A throwaway hosted-body stand-in: the real /v1/accounts and /v1/work routes,
// a real file credential broker in a temp directory, and a fake GitHub (device
// flow, /user, grant revocation, issues). No real GitHub or Linear is called
// and the owner's running service is untouched. Prints the paths run.sh checks.
import { mkdtemp, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serve } from "@hono/node-server";
import { FileCredentialStore } from "@clankie/credential-broker";
import { createAccounts, githubConnectionToken } from "../../../../apps/clankie/src/accounts.ts";
import { createClankieApp } from "../../../../apps/clankie/src/app.ts";
import { createStubCaptain } from "../../../../apps/clankie/src/captain/port.ts";
import { createWorkItemsService } from "../../../../apps/clankie/src/work-items.ts";

const token = process.env.CLANKIE_OPERATOR_TOKEN;
const port = Number(process.env.PORT ?? "4398");
if (token === undefined) throw new Error("set CLANKIE_OPERATOR_TOKEN");
// Deliberately recognizable, so run.sh can prove it appears nowhere but the broker.
const GITHUB_TOKEN = "gho_PROOF_connection_token_4c1e9b";

const dir = await mkdtemp(join(tmpdir(), "hosted-connections-proof-"));
const repo = join(dir, "repo");
await writeFile(join(dir, ".keep"), "");
const store = new FileCredentialStore(join(dir, "credentials.json"));
await store.set("github-oauth-app", { type: "api", key: "PROOF_app_secret_77ad" });

const issues: Record<string, unknown>[] = [];
let polls = 0;
const github = createServer((request, response) => {
  let body = "";
  request.on("data", (chunk) => (body += String(chunk)));
  request.on("end", () => {
    const url = new URL(request.url ?? "/", "http://fake");
    const route = `${request.method} ${url.pathname}`;
    console.error(`fake-github ${route}`);
    const json = (status: number, value?: unknown) => {
      response.writeHead(status, { "content-type": "application/json" });
      response.end(value === undefined ? "" : JSON.stringify(value));
    };
    if (route === "POST /login/device/code")
      return json(200, {
        device_code: "proof-device-code",
        user_code: "PRUF-2026",
        verification_uri: "https://github.com/login/device",
        expires_in: 900,
        interval: 1,
      });
    if (route === "POST /login/oauth/access_token")
      return (polls += 1) < 2
        ? json(200, { error: "authorization_pending" })
        : json(200, { access_token: GITHUB_TOKEN, token_type: "bearer", scope: "repo" });
    if (route === "GET /user") return json(200, { login: "proof-owner" });
    if (request.method === "DELETE" && url.pathname.startsWith("/applications/")) return json(204);
    if (url.pathname === "/repos/proof/repo/issues") {
      if (request.headers.authorization !== `Bearer ${GITHUB_TOKEN}`)
        return json(401, { message: "Bad credentials" });
      if (request.method === "POST") {
        const created = {
          number: issues.length + 1,
          html_url: `https://github.com/proof/repo/issues/${String(issues.length + 1)}`,
          state: "open",
          labels: [],
          ...(JSON.parse(body) as Record<string, unknown>),
        };
        issues.push(created);
        return json(201, created);
      }
      return json(200, issues);
    }
    return json(404, { message: "Not Found" });
  });
});
await new Promise<void>((resolve) => github.listen(0, "127.0.0.1", resolve));
const address = github.address();
const origin = `http://127.0.0.1:${String(typeof address === "object" && address ? address.port : 0)}`;

const { app } = await createClankieApp({
  captain: createStubCaptain(),
  eventLogPath: join(dir, "events.jsonl"),
  accounts: createAccounts({
    store,
    apps: async () => ({ github: { clientId: "Ov23liProofClient" }, linear: {} }),
    githubWeb: origin,
    githubApi: origin,
  }),
  workItems: createWorkItemsService({
    stateDirectory: dir,
    workspace: () => repo,
    githubToken: () => githubConnectionToken(store),
    hosted: true,
    githubApiBase: origin,
  }),
  authenticateOperator: async (request) =>
    request.headers.get("authorization") === `Bearer ${token}` ? { operatorId: "proof" } : undefined,
});
serve({ fetch: app.fetch, hostname: "127.0.0.1", port });
console.log(JSON.stringify({ url: `http://127.0.0.1:${String(port)}`, dir, repo, fakeGithub: origin }));
