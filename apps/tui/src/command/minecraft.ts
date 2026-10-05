import { randomUUID } from "node:crypto";
import { resolveOperatorCredential, type CredentialStore } from "@clankie/credential-broker";
import { MinecraftCommandSchema } from "@clankie/protocol";
import {
  MinecraftConfiguredProfileSchema,
  MinecraftPublicEndpointSchema,
  SettingsStore,
  defaultSettingsPath,
} from "@clankie/settings";
import { commandHost } from "./io.ts";
import { runMinecraftHostCommand } from "./minecraft-host.ts";

const USAGE =
  "Usage: clankie minecraft host status|configure [JSON]|start|stop|restart|backup|admin JSON|approve USERNAME|tunnel claim|status|complete | configure [PROFILE HOST --version VERSION [--port PORT] [--username NAME] [--name LABEL] [--allow-public] | remove PROFILE | allow-public HOST [PORT] | revoke-public HOST [PORT]] | status | profiles | join PROFILE | leave | cancel [ACTION] | pause | resume | observe | action JSON | action-status ACTION | chat TEXT | follow PLAYER [DISTANCE] | goto X Y Z [TOLERANCE] | dig X Y Z | place X Y Z ITEM | craft ITEM COUNT";

async function configure(args: readonly string[], store: SettingsStore): Promise<Record<string, unknown>> {
  if (args.length === 0) return { minecraft: (await store.load()).minecraft };
  if (args[0] === "remove" && args.length === 2) {
    const updated = await store.update((current) => ({
      ...current,
      minecraft: {
        ...current.minecraft,
        profiles: current.minecraft.profiles.filter((profile) => profile.id !== args[1]),
      },
    }));
    return { outcome: "ok", minecraft: updated.minecraft };
  }
  if (
    (args[0] === "allow-public" || args[0] === "revoke-public") &&
    (args.length === 2 || args.length === 3)
  ) {
    const endpoint = MinecraftPublicEndpointSchema.safeParse({
      host: args[1],
      ...(args[2] === undefined ? {} : { port: Number(args[2]) }),
    });
    if (!endpoint.success) throw new Error(USAGE);
    const updated = await store.update((current) => {
      const retained = current.minecraft.publicAllowlist.filter(
        (entry) => entry.host !== endpoint.data.host || entry.port !== endpoint.data.port,
      );
      return {
        ...current,
        minecraft: {
          ...current.minecraft,
          publicAllowlist: args[0] === "allow-public" ? [...retained, endpoint.data] : retained,
        },
      };
    });
    return { outcome: "ok", minecraft: updated.minecraft };
  }
  const [id, host, ...flags] = args;
  if (!id || !host) throw new Error(USAGE);
  const fields: Record<string, unknown> = {};
  let allowPublic = false;
  for (let index = 0; index < flags.length; index++) {
    const flag = flags[index]!;
    if (flag === "--allow-public") {
      if (allowPublic) throw new Error(USAGE);
      allowPublic = true;
      continue;
    }
    const field = (
      { "--port": "port", "--version": "version", "--username": "username", "--name": "name" } as Record<
        string,
        string
      >
    )[flag];
    const value = flags[++index];
    if (!field || value === undefined || value.startsWith("--") || field in fields) throw new Error(USAGE);
    fields[field] = field === "port" ? Number(value) : value;
  }
  const updated = await store.update((current) => {
    const existing = current.minecraft.profiles.find((entry) => entry.id === id);
    const parsed = MinecraftConfiguredProfileSchema.safeParse({
      ...existing,
      id,
      name: existing?.name ?? id,
      host,
      ...fields,
    });
    if (!parsed.success) throw new Error(USAGE);
    const profile = parsed.data;
    const publicAllowlist =
      allowPublic &&
      !current.minecraft.publicAllowlist.some(
        (entry) => entry.host === profile.host && entry.port === profile.port,
      )
        ? [...current.minecraft.publicAllowlist, { host: profile.host, port: profile.port }]
        : current.minecraft.publicAllowlist;
    return {
      ...current,
      minecraft: {
        profiles: [...current.minecraft.profiles.filter((entry) => entry.id !== id), profile],
        publicAllowlist,
      },
    };
  });
  return { outcome: "ok", minecraft: updated.minecraft };
}

export async function runMinecraftCommand(
  args: readonly string[],
  options: {
    env?: NodeJS.ProcessEnv;
    host?: string;
    fetchImpl?: typeof fetch;
    operatorCredentialStore?: CredentialStore;
    settings?: SettingsStore;
    conversationId?: string;
  } = {},
): Promise<Record<string, unknown>> {
  const commandArgs = [...args];
  const conversationFlag = commandArgs.indexOf("--conversation");
  let conversationId = options.conversationId;
  if (conversationFlag !== -1) {
    const value = commandArgs[conversationFlag + 1];
    if (!value || value.startsWith("--") || commandArgs.lastIndexOf("--conversation") !== conversationFlag)
      throw new Error(USAGE);
    conversationId = value;
    commandArgs.splice(conversationFlag, 2);
  }
  if (
    conversationId !== undefined &&
    (!conversationId.trim() || conversationId.length > 512 || /[\r\n]/u.test(conversationId))
  )
    throw new Error(USAGE);
  const [action = "status", ...rest] = commandArgs;
  const env = options.env ?? process.env;
  if (action === "host")
    return runMinecraftHostCommand(rest, {
      ...options,
      ...(conversationId === undefined ? {} : { conversationId }),
    });
  if (action === "configure")
    return configure(rest, options.settings ?? new SettingsStore(defaultSettingsPath(env)));
  let raw: unknown;
  if (["status", "profiles", "leave", "pause", "resume", "observe"].includes(action) && rest.length === 0)
    raw = { action };
  else if (action === "join" && rest.length === 1) raw = { action, profileId: rest[0] };
  else if (action === "cancel" && rest.length <= 1)
    raw = { action, ...(rest[0] === undefined ? {} : { actionId: rest[0] }) };
  else if (action === "action-status" && rest.length === 1)
    raw = { action: "action_status", actionId: rest[0] };
  else {
    let request: unknown;
    if (action === "action" && rest.length === 1) {
      try {
        request = JSON.parse(rest[0]!);
      } catch {
        throw new Error(USAGE);
      }
    } else if (action === "chat" && rest.length) request = { type: "chat", text: rest.join(" ") };
    else if (action === "follow" && (rest.length === 1 || rest.length === 2))
      request = { type: "follow", player: rest[0], distance: rest[1] === undefined ? 2 : Number(rest[1]) };
    else if (
      ["goto", "dig", "place"].includes(action) &&
      (rest.length === 3 || (rest.length === 4 && action !== "dig"))
    ) {
      const position = { x: Number(rest[0]), y: Number(rest[1]), z: Number(rest[2]) };
      request = {
        type: action,
        position,
        ...(action === "goto"
          ? { tolerance: rest[3] === undefined ? 1 : Number(rest[3]) }
          : action === "place"
            ? { item: rest[3] }
            : {}),
      };
    } else if (action === "craft" && rest.length === 2)
      request = { type: "craft", item: rest[0], count: Number(rest[1]) };
    if (request === undefined) throw new Error(USAGE);
    raw = { action: "act", actionId: randomUUID(), request };
  }
  const parsed = MinecraftCommandSchema.safeParse(raw);
  if (!parsed.success) throw new Error(USAGE);
  const credential = await resolveOperatorCredential({
    env,
    ...(options.operatorCredentialStore === undefined ? {} : { store: options.operatorCredentialStore }),
  });
  if (!credential)
    throw new Error("No operator credential is available; start the clankie service once first.");
  const response = await (options.fetchImpl ?? fetch)(
    new URL("/v1/minecraft", commandHost({ ...options, env })),
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${credential.token}`,
        "content-type": "application/json",
        ...(conversationId === undefined ? {} : { "x-clankie-conversation-id": conversationId }),
      },
      body: JSON.stringify(parsed.data),
      signal: AbortSignal.timeout(30_000),
    },
  );
  if (!response.ok) {
    const result: unknown = await response.json().catch(() => undefined);
    const code =
      result !== null &&
      typeof result === "object" &&
      "error" in result &&
      typeof result.error === "string" &&
      /^[a-z_]{1,64}$/u.test(result.error)
        ? `: ${result.error}`
        : "";
    throw new Error(`clankie service returned ${response.status}${code}`);
  }
  return (await response.json()) as Record<string, unknown>;
}
