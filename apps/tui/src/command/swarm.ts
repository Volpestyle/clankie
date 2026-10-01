import { readFile, stat, writeFile } from "node:fs/promises";
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
  if (args[0] === "contacts" || args[0] === "tasks" || args[0] === "message" || args[0] === "thread") {
    if (
      ((args[0] === "contacts" || args[0] === "tasks") && args.length !== 1) ||
      (args[0] === "thread" && args.length !== 2) ||
      (args[0] === "message" && args.length < 3)
    )
      throw new Error("Usage: clankie swarm contacts | tasks | thread PERSONA | message PERSONA TEXT");
    const token = await resolveCaptainRouteToken({ env: options.env ?? process.env });
    const client = createCaptainOperatorConversationClient(
      createCaptainRouteClient({
        host: commandHost(options),
        ...(token ? { captainToken: token } : {}),
        ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
      }),
    );
    const fleet = await client.fleet!();
    // The same unfinished work, lead and owner the app's bulletin shows (ADR 0205).
    if (args[0] === "tasks") return fleet.tasks ?? [];
    const contacts = fleet.personas.filter((persona) => persona.swarm);
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
    body: string | undefined,
    fleetPeerOut: string | undefined;
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
  } else if (args[0] === "fleet-peer") {
    // A peer on a registered ssh fleet joins this conversation's coordinator
    // through the fleet's relay (VUH-1381). The capability is written to a
    // private file for that peer, never printed.
    const [, fleet, name, ...flags] = args;
    const conversation = flags[flags.indexOf("--conversation") + 1];
    const out = flags[flags.indexOf("--out") + 1];
    if (
      fleet === undefined ||
      name === undefined ||
      flags.length !== 4 ||
      !flags.includes("--conversation") ||
      !flags.includes("--out") ||
      conversation === undefined ||
      out === undefined
    )
      throw new Error("Usage: clankie swarm fleet-peer FLEET NAME --conversation ID --out PRIVATE.json");
    fleetPeerOut = out;
    body = JSON.stringify({ conversationId: conversation, fleet, name });
    path += "/fleet-peers";
    method = "POST";
  } else if (args.length > 1 || (args[0] !== undefined && !["status", "connections"].includes(args[0])))
    throw new Error(
      "Usage: clankie swarm [status|connections] | connect PRIVATE.json | disconnect ID | fleet-peer FLEET NAME --conversation ID --out PRIVATE.json",
    );
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
  if (!response.ok) {
    const detail = (await response.json().catch(() => undefined)) as { detail?: unknown } | undefined;
    throw new Error(
      typeof detail?.detail === "string" ? detail.detail : `Swarm connection request: ${response.status}`,
    );
  }
  const result = (await response.json()) as Record<string, unknown>;
  if (fleetPeerOut === undefined) return result;
  await writeFile(fleetPeerOut, `${JSON.stringify(result, null, 2)}\n`, { mode: 0o600, flag: "wx" });
  const { environment: _secret, ...visible } = result;
  return { ...visible, written: fleetPeerOut };
}
