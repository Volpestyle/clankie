import { readFile, stat } from "node:fs/promises";
import { resolveOperatorCredential, type CredentialStore } from "@clankie/credential-broker";
import { commandHost } from "./io.ts";
import {
  createCaptainOperatorConversationClient,
  createCaptainRouteClient,
  resolveCaptainRouteToken,
} from "../session/operator-conversations.ts";

export async function runSwarmCommand(
  args: readonly string[],
  options: {
    env?: NodeJS.ProcessEnv;
    host?: string;
    fetchImpl?: typeof fetch;
    operatorCredentialStore?: CredentialStore;
  } = {},
): Promise<unknown> {
  if (args[0] === "contacts" || args[0] === "message" || args[0] === "thread") {
    if (
      (args[0] === "contacts" && args.length !== 1) ||
      (args[0] === "thread" && args.length !== 2) ||
      (args[0] === "message" && args.length < 3)
    )
      throw new Error("Usage: clankie swarm contacts | thread PERSONA | message PERSONA TEXT");
    const token = await resolveCaptainRouteToken({ env: options.env ?? process.env });
    const client = createCaptainOperatorConversationClient(
      createCaptainRouteClient({
        host: commandHost(options),
        ...(token ? { captainToken: token } : {}),
        ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
      }),
    );
    const contacts = (await client.fleet!()).personas.filter((persona) => persona.swarm);
    if (args[0] === "contacts") return contacts;
    const persona = contacts.find((entry) => entry.personaId === args[1]);
    if (!persona) throw new Error("Unknown Swarm contact; use clankie swarm contacts");
    const conversation = await client.create({
      scope: { kind: "persona", personaId: persona.personaId },
      title: persona.name,
    });
    if (args[0] === "thread")
      return {
        conversation,
        replay: await client.replay({
          schemaVersion: 1,
          conversationId: conversation.conversationId,
          surfaceClientId: "cli-swarm",
        }),
      };
    return client.send({
      schemaVersion: 1,
      conversationId: conversation.conversationId,
      surfaceClientId: "cli-swarm",
      expectedRevision: conversation.revision,
      kind: "message",
      message: args.slice(2).join(" "),
      delivery: "queue",
    });
  }
  let path = "/v1/swarm",
    method = "GET",
    body: string | undefined;
  if (args.length === 2 && args[0] === "connect") {
    const file = await stat(args[1]!);
    if (
      !file.isFile() ||
      file.size > 16 * 1024 ||
      (process.platform !== "win32" && (file.mode & 0o077) !== 0)
    )
      throw new Error("Swarm connection file must be private (0600), regular, and at most 16 KiB");
    body = JSON.stringify(JSON.parse(await readFile(args[1]!, "utf8")));
    path += "/connections";
    method = "POST";
  } else if (args.length === 2 && args[0] === "disconnect") {
    path += `/connections/${encodeURIComponent(args[1]!)}`;
    method = "DELETE";
  } else if (args.length > 1 || (args[0] !== undefined && !["status", "connections"].includes(args[0])))
    throw new Error("Usage: clankie swarm [status|connections] | connect PRIVATE.json | disconnect ID");
  const credential = await resolveOperatorCredential({
    env: options.env ?? process.env,
    ...(options.operatorCredentialStore === undefined ? {} : { store: options.operatorCredentialStore }),
  });
  if (!credential) throw new Error("Swarm status needs the operator credential. Run clankie doctor.");
  const response = await (options.fetchImpl ?? fetch)(`${commandHost(options)}${path}`, {
    method,
    headers: { authorization: `Bearer ${credential.token}`, "content-type": "application/json" },
    ...(body === undefined ? {} : { body }),
    signal: AbortSignal.timeout(30000),
  });
  if (!response.ok) throw new Error(`Swarm connection request: ${response.status}`);
  return response.json();
}
