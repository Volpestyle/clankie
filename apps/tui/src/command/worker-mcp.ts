import { readFile, realpath, stat } from "node:fs/promises";
import { CapabilityGrantSchema } from "@clankie/credential-broker";
import { z } from "zod";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";

function workerEndpoint(endpoint: string): URL {
  const url = new URL(endpoint);
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    (url.protocol !== "https:" &&
      !(
        url.protocol === "http:" &&
        (url.hostname === "localhost" || /^127(\.\d{1,3}){3}$/u.test(url.hostname))
      ))
  )
    throw new Error("Worker endpoint must use HTTPS or loopback HTTP");
  return url;
}

/** Worker-only bridge: no operator credential, seat outbox or channel capability. */
export async function runWorkerMcp(path: string, transport?: Transport): Promise<number> {
  const grantPath = await realpath(path);
  const metadata = await stat(grantPath);
  if ((metadata.mode & 0o077) !== 0) throw new Error("Worker grant file must be private (chmod 600)");
  const grant = z
    .object({
      endpoint: z.string().url(),
      token: z.string().min(1),
      grant: CapabilityGrantSchema.optional(),
    })
    .parse(JSON.parse(await readFile(grantPath, "utf8")));
  if (JSON.parse(await readFile(grantPath, "utf8")).renewable === true)
    throw new Error("Retired renewable worker grant; issue a manual or project grant");
  const url = workerEndpoint(grant.endpoint);
  const upstream = new Client({ name: "clankie-worker-bridge", version: "1" });
  const server = new Server({ name: "clankie-worker", version: "1" }, { capabilities: { tools: {} } });
  const closed = new Promise<void>((resolve) => {
    server.onclose = resolve;
  });
  try {
    await upstream.connect(
      new StreamableHTTPClientTransport(url, {
        fetch: async (input, init) => {
          const headers = new Headers(init?.headers);
          headers.set("authorization", `Bearer ${grant.token}`);
          return fetch(input, { ...init, headers });
        },
      }) as unknown as Transport,
    );
    server.setRequestHandler(ListToolsRequestSchema, () => upstream.listTools());
    server.setRequestHandler(CallToolRequestSchema, (request) => upstream.callTool(request.params));
    await server.connect(transport ?? new StdioServerTransport());
    await closed;
    return 0;
  } finally {
    await server.close();
    await upstream.close();
  }
}
