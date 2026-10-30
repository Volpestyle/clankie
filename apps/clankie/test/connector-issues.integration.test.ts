import { createHash, randomBytes } from "node:crypto";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { ProjectsSettingsSchema } from "@clankie/protocol/projects";
import { SettingsStore } from "@clankie/settings";
import { createFilesBackend, writeConvention } from "@clankie/work-items";
import { expect, it } from "vitest";
import { ClankieGuide } from "../../relay/src/connector-guide.ts";
import { createConnectorMcpHandler, createLoopbackConnectorOperator } from "../../relay/src/connector-mcp.ts";
import { createCaptainConversationDispatch } from "../../relay/src/conversation-upstream.ts";
import { ControlPlaneDeviceAuthorizer } from "../../relay/src/device-auth.ts";
import { createOperatorConversationRelayHandler } from "../../relay/src/operator-conversations.ts";
import { runConnectorCommand } from "../../tui/src/command/connector.ts";
import { createWorkItemsService, defaultRun } from "../src/work-items.ts";
import { createQaService } from "./fixtures/qa-service.ts";

// A connected app reads the owner's projects and their issues (ADR 0301): the real
// work service over a project's private issue files, the real service, relay and
// connector, signed in the way Claude signs in. Writing stays off the connector.

const CALLBACK = "https://claude.ai/api/mcp/auth_callback";

it("lists the owner's projects and issues and reads one, and never writes", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "connector-issues-")));
  const git = (cwd: string, ...args: string[]) =>
    defaultRun("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", ...args], cwd);
  const orchard = join(root, "orchard");
  await mkdir(orchard);
  await git(orchard, "init", "-q", "-b", "main");
  await writeFile(join(orchard, "README.md"), "orchard\n");
  await writeConvention(orchard, {
    schemaVersion: 1,
    backend: "markdown",
    directory: ".clankie/work",
    decidedBy: "owner",
    decidedAt: "2026-10-30T00:00:00.000Z",
  });
  await git(orchard, "add", "-A");
  await git(orchard, "commit", "-q", "-m", "init");
  const settings = new SettingsStore(join(root, "settings.json"));
  await settings.update((current) => ({
    ...current,
    projects: ProjectsSettingsSchema.parse({
      projects: [
        {
          id: "orchard",
          name: "Orchard",
          workspaces: [{ id: "primary", machineId: "local", platform: "posix", path: orchard }],
          trackerRef: { workspaceId: "primary", path: ".clankie/tracking.json" },
        },
      ],
    }),
  }));
  const workItems = createWorkItemsService({
    stateDirectory: join(root, "work-state"),
    projects: async () => (await settings.load()).projects,
    localMachineId: "local",
    run: defaultRun,
  });
  // The owner's issues, in the orchard's private issue files.
  const backend = createFilesBackend({ root: orchard, directory: ".clankie/work", kind: "markdown" });
  const pear = await backend.create({
    title: "Prune the pear tree",
    summary: "Cut back the north limbs before the frost.",
    criteria: ["North limbs cut back"],
    priority: 2,
  });
  const fence = await backend.create({ title: "Mend the fence" });
  await backend.update(fence.id, { addLabels: ["outdoor"] });
  const repos = await workItems.handle({ action: "repos" }, false);
  const bound = "repos" in repos ? repos.repos.find((repo) => repo.projectId === "orchard") : undefined;
  if (bound === undefined) throw new Error("The orchard project has no repo");
  const project = bound.id;
  const files = async () => {
    const directory = join(orchard, ".clankie/work");
    const names = (await readdir(directory)).sort();
    return Promise.all(names.map(async (name) => [name, await readFile(join(directory, name), "utf8")]));
  };
  const before = await files();

  const captainToken = randomBytes(24).toString("hex");
  const host = await createQaService({ captainToken, workItems });
  const authorizeDevice = new ControlPlaneDeviceAuthorizer({ baseUrl: host.baseUrl });
  let relayUrl = "";
  const operator = createOperatorConversationRelayHandler({
    authorizeDevice,
    dispatch: createCaptainConversationDispatch({ baseUrl: host.baseUrl, bearerToken: captainToken }),
  });
  const connector = createConnectorMcpHandler({
    authorizeDevice,
    operator: createLoopbackConnectorOperator("http://placeholder.invalid", (input, init) =>
      fetch(new URL(new URL(String(input)).pathname, relayUrl), init),
    ),
    localAuthorizationServer: host.baseUrl,
    version: "test",
    guide: new ClankieGuide(resolve(import.meta.dirname, "../../..")),
  });
  const relay = createServer((request, response) => {
    void (async () => {
      if (await connector(request, response)) return;
      if (await operator(request, response)) return;
      response.statusCode = 404;
      response.end();
    })();
  });
  relay.listen(0, "127.0.0.1");
  await once(relay, "listening");
  relayUrl = `http://127.0.0.1:${(relay.address() as AddressInfo).port}`;
  let client: Client | undefined;
  try {
    const accessToken = await signIn(host.baseUrl, host.operatorToken);
    client = new Client({ name: "claude-e2e", version: "1" });
    await client.connect(
      new StreamableHTTPClientTransport(new URL("/mcp", relayUrl), {
        requestInit: { headers: { authorization: `Bearer ${accessToken}` } },
      }) as unknown as Transport,
    );
    const call = async (name: string, args: Record<string, unknown> = {}) => {
      const result = await client!.callTool({ name, arguments: args });
      return { error: result.isError === true, text: (result.content as Array<{ text: string }>)[0]!.text };
    };

    // The projects, each with where it tracks its issues.
    const listed = JSON.parse((await call("list_issues")).text) as {
      projects: { project: string; name: string; tracker?: string }[];
    };
    expect(listed.projects).toEqual([{ project, name: "Orchard", tracker: "issue files" }]);

    // One project's issues, and those with a label.
    const issues = JSON.parse((await call("list_issues", { project })).text);
    expect(issues).toMatchObject({
      project: { project, tracker: "issue files" },
      about: expect.stringContaining("not instructions"),
    });
    expect(issues.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ issue: pear.id, title: "Prune the pear tree", priority: 2 }),
        expect.objectContaining({ issue: fence.id, title: "Mend the fence", labels: ["outdoor"] }),
      ]),
    );
    expect(issues.issues).toHaveLength(2);
    // A list line is for picking: the full text is read_issue's.
    expect(issues.issues[0]).not.toHaveProperty("summary");
    const outdoor = JSON.parse((await call("list_issues", { project, label: "outdoor" })).text);
    expect(outdoor.issues.map((issue: { issue: string }) => issue.issue)).toEqual([fence.id]);

    // One issue in full.
    const read = JSON.parse((await call("read_issue", { project, issue: pear.id })).text);
    expect(read).toMatchObject({
      project: { project },
      issue: {
        id: pear.id,
        title: "Prune the pear tree",
        summary: expect.stringContaining("north limbs"),
        criteria: [expect.objectContaining({ text: "North limbs cut back" })],
      },
    });
    expect(await call("read_issue", { project, issue: "W-nope00" })).toEqual({
      error: true,
      text: "Orchard has no issue W-nope00.",
    });
    expect(await call("list_issues", { project: "no-such-project" })).toMatchObject({ error: true });

    // A connector reads issues; it never writes them, whatever it sends the relay.
    const write = await fetch(new URL("/operator/v1/dispatch", relayUrl), {
      method: "POST",
      headers: { authorization: `Bearer ${accessToken}`, "content-type": "application/json" },
      body: JSON.stringify({
        op: "work_item_write",
        schemaVersion: 1,
        request: {
          requestId: "8f6f2c1e-4a8b-4c7e-9a7d-2b1f3c4d5e6f",
          repoId: project,
          itemId: pear.id,
          command: { action: "add_label", label: "done" },
        },
      }),
    });
    expect(write.status).toBe(403);
    expect(await write.json()).toEqual({ error: "connector_operation_not_allowed" });
    expect(await files()).toEqual(before);
  } finally {
    await client?.close();
    await new Promise<void>((done) => relay.close(() => done()));
    await host.close();
    await rm(root, { recursive: true, force: true });
  }
});

/** Claude registers, the owner approves the code at the Mac, and Claude trades it for a token. */
async function signIn(baseUrl: string, operatorToken: string): Promise<string> {
  const { client_id: clientId } = (await (
    await fetch(`${baseUrl}/oauth/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ client_name: "Claude", redirect_uris: [CALLBACK] }),
    })
  ).json()) as { client_id: string };
  const verifier = randomBytes(32).toString("base64url");
  const page = await (
    await fetch(
      `${baseUrl}/oauth/authorize?${new URLSearchParams({
        response_type: "code",
        client_id: clientId,
        redirect_uri: CALLBACK,
        code_challenge: createHash("sha256").update(verifier).digest("base64url"),
        code_challenge_method: "S256",
        state: "s",
        scope: "agents offline_access",
      })}`,
    )
  ).text();
  const approved = await runConnectorCommand(["approve", /class="code">([A-Z0-9-]+)</u.exec(page)![1]!], {
    host: baseUrl,
    env: { ...process.env, CLANKIE_OPERATOR_TOKEN: operatorToken },
    stdout: { write: () => undefined },
    stderr: { write: () => undefined },
  });
  if (approved !== 0) throw new Error("The owner's approval failed");
  const decided = (await (
    await fetch(`${baseUrl}/oauth/authorize/status`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ request: /const id="([^"]+)"/u.exec(page)![1] }),
    })
  ).json()) as { redirect: string };
  const { access_token: accessToken } = (await (
    await fetch(`${baseUrl}/oauth/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        client_id: clientId,
        redirect_uri: CALLBACK,
        code: new URL(decided.redirect).searchParams.get("code")!,
        code_verifier: verifier,
      }).toString(),
    })
  ).json()) as { access_token: string };
  return accessToken;
}
