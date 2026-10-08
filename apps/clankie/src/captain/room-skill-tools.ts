import { execFile } from "node:child_process";
import { readFile, writeFile, mkdir, realpath, lstat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";
import { createDefaultCredentialStore } from "@clankie/credential-broker";
import type { DiscordSettings } from "@clankie/protocol";
import type { ToolDefinition, ResourceLoader } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { z } from "zod";
import { toolJson } from "./tools.ts";

export interface DiscordSessionAccess {
  readonly privateContext: boolean;
  readonly actorId: string;
  readonly skillGrant?: DiscordSettings["roomSkills"][number];
  readonly authorize: () => Promise<boolean>;
  /** Host-only override for isolated integration workspaces, never tool input. */
  readonly home?: string;
  readonly skillRoot?: string;
}

/** Include only this session's authored and trusted extension tools, never hidden builtins. */
export function discordAllowedToolNames(
  authored: readonly ToolDefinition[],
  loader: ResourceLoader,
): string[] {
  return [
    ...new Set([
      ...authored.map((tool) => tool.name),
      ...loader.getExtensions().extensions.flatMap((extension) => [...extension.tools.keys()]),
    ]),
  ];
}
const Text = z.string().min(1).max(4000);
const Id = z
  .string()
  .min(1)
  .max(256)
  .refine((value) => !value.startsWith("-"), "Invalid property id");
const Operation = z.discriminatedUnion("operation", [
  z.object({ operation: z.literal("criteria") }).strict(),
  z
    .object({
      operation: z.literal("criteria_update"),
      expected: z.string().max(32000),
      text: z.string().max(32000),
    })
    .strict(),
  z.object({ operation: z.literal("list"), all: z.boolean().optional() }).strict(),
  z.object({ operation: z.literal("show"), id: Id }).strict(),
  z
    .object({
      operation: z.literal("feedback"),
      id: Id,
      decision: z.enum(["save", "reject", "reconsider", "tour", "note"]),
      note: Text,
    })
    .strict(),
  z.object({ operation: z.literal("changes"), since: z.iso.datetime() }).strict(),
  z
    .object({
      operation: z.literal("import"),
      observations: z.array(z.record(z.string(), z.json())).min(1).max(100),
    })
    .strict(),
  z
    .object({
      operation: z.literal("search"),
      location: Text,
      maxPrice: z.number().int().positive().max(100000000),
      bedrooms: z.number().int().min(0).max(30).optional(),
      page: z.number().int().min(1).max(100).optional(),
      limit: z.number().int().min(1).max(100).optional(),
      refresh: z.boolean().optional(),
    })
    .strict(),
  z
    .object({
      operation: z.literal("detail"),
      zpid: z.string().regex(/^\d{1,32}$/u),
      refresh: z.boolean().optional(),
    })
    .strict(),
]);
const runFile = promisify(execFile);
function paths(access: DiscordSessionAccess) {
  const grant = access.skillGrant!;
  return {
    skill: access.skillRoot ?? join(homedir(), ".agents", "skills", "house-hunting"),
    home:
      access.home ??
      (grant.household === "existing"
        ? join(homedir(), ".local", "share", "house-hunting")
        : join(
            homedir(),
            ".local",
            "share",
            "clankie",
            "households",
            `${grant.serverId}-${grant.channelId}`,
          )),
  };
}
export async function houseHuntingInstructions(access?: DiscordSessionAccess): Promise<string> {
  if (access?.skillGrant?.skill !== "house-hunting") return "";
  const { skill } = paths(access);
  const instructions = await readFile(join(skill, "SKILL.md"), "utf8").catch(() => "");
  return (
    `\n\n# This room can use: house hunting\nUse house_hunting for criteria, ledger, feedback and listing API operations. ` +
    `Its household is bound by the host; feedback is attributed to the authenticated speaker. ` +
    `Read criteria before research; save and read back changes. Shell examples below describe the owner's installation; ` +
    `use the structured tool here. No shell, arbitrary files, fleet tools, other skills or credentials are granted.\n${instructions}`
  );
}

/** A fixed capability adapter, never a shell or a caller-selected executable/path. */
function houseHuntingTools(access?: DiscordSessionAccess): ToolDefinition[] {
  if (access?.skillGrant?.skill !== "house-hunting") return [];
  return [
    {
      name: "house_hunting",
      label: "House hunting",
      description:
        "Read and update this room's household criteria, research homes and maintain its shortlist. " +
        "Operations: criteria, criteria_update (expected/text), list (all), show (id), feedback (id/decision/note), " +
        "changes (since), import (observations), search (location/maxPrice/bedrooms/page/limit/refresh), detail (zpid/refresh). " +
        "No commands or paths. Feedback is attributed to the current Discord speaker. Criteria updates require the exact text last read.",
      parameters: Type.Object(
        {
          operation: Type.Union(
            [
              "criteria",
              "criteria_update",
              "list",
              "show",
              "feedback",
              "changes",
              "import",
              "search",
              "detail",
            ].map((value) => Type.Literal(value)),
          ),
          expected: Type.Optional(Type.String({ maxLength: 32000 })),
          text: Type.Optional(Type.String({ maxLength: 32000 })),
          all: Type.Optional(Type.Boolean()),
          id: Type.Optional(Type.String({ maxLength: 256 })),
          decision: Type.Optional(
            Type.Union(["save", "reject", "reconsider", "tour", "note"].map((value) => Type.Literal(value))),
          ),
          note: Type.Optional(Type.String({ maxLength: 4000 })),
          since: Type.Optional(Type.String()),
          observations: Type.Optional(
            Type.Array(Type.Record(Type.String(), Type.Unknown()), { maxItems: 100 }),
          ),
          location: Type.Optional(Type.String({ maxLength: 4000 })),
          maxPrice: Type.Optional(Type.Integer({ minimum: 1, maximum: 100000000 })),
          bedrooms: Type.Optional(Type.Integer({ minimum: 0, maximum: 30 })),
          page: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
          limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
          zpid: Type.Optional(Type.String({ pattern: "^\\d{1,32}$" })),
          refresh: Type.Optional(Type.Boolean()),
        },
        { additionalProperties: false },
      ),
      executionMode: "sequential",
      execute: async (_id, params, signal) =>
        withHouseholdQueue(paths(access).home, async () => {
          signal?.throwIfAborted();
          const input = Operation.parse(params);
          if (!(await access.authorize())) throw new Error("room_skill_grant_revoked");
          const { skill, home } = paths(access);
          await mkdir(home, { recursive: true, mode: 0o700 });
          const root = await realpath(home);
          const criteria = join(root, "criteria.md");
          for (const file of ["criteria.md", "homes.sqlite3"]) {
            const stat = await lstat(join(root, file)).catch((error: NodeJS.ErrnoException) => {
              if (error.code !== "ENOENT") throw error;
              return undefined;
            });
            if (stat?.isSymbolicLink()) throw new Error("household_symlink_refused");
          }
          if (input.operation === "criteria" || input.operation === "criteria_update") {
            const current = await readFile(criteria, "utf8").catch((error: NodeJS.ErrnoException) => {
              if (error.code !== "ENOENT") throw error;
              return "";
            });
            if (input.operation === "criteria") return toolJson({ criteria: current });
            if (current !== input.expected) throw new Error("household_criteria_changed");
            if (!(await access.authorize())) throw new Error("room_skill_grant_revoked");
            await writeFile(criteria, input.text, { mode: 0o600 });
            return toolJson({ criteria: await readFile(criteria, "utf8"), recordedBy: access.actorId });
          }
          const args = [join(skill, "homes.py"), "--home", root, input.operation];
          let temporary: string | undefined;
          if (input.operation === "list" && input.all) args.push("--all");
          if (input.operation === "show") args.push(input.id);
          if (input.operation === "feedback")
            args.push(input.id, "--by", access.actorId, "--decision", input.decision, "--note", input.note);
          if (input.operation === "changes") args.push("--since", input.since);
          if (input.operation === "import") {
            temporary = join(root, `observations-${randomUUID()}.json`);
            await writeFile(temporary, JSON.stringify(input.observations), { mode: 0o600, flag: "wx" });
            args.push(temporary);
          }
          if (input.operation === "search") {
            args.push("--location", input.location, "--max-price", String(input.maxPrice));
            if (input.bedrooms !== undefined) args.push("--bedrooms", String(input.bedrooms));
            if (input.page !== undefined) args.push("--page", String(input.page));
            if (input.limit !== undefined) args.push("--limit", String(input.limit));
          }
          if (input.operation === "detail") args.push(input.zpid);
          const env: NodeJS.ProcessEnv = { PATH: process.env.PATH, HOME: homedir(), LANG: "en_US.UTF-8" };
          if (input.operation === "search" || input.operation === "detail") {
            if (input.refresh) args.push("--refresh");
            const credential = await createDefaultCredentialStore().get("axesso");
            if (credential?.type !== "api") throw new Error("house_hunting_api_unavailable");
            env.AXESSO_API_KEY = credential.key;
          }
          try {
            if (!(await access.authorize())) throw new Error("room_skill_grant_revoked");
            const { stdout } = await runFile("python3", args, {
              env,
              timeout: 60000,
              maxBuffer: 1024 * 1024,
              ...(signal ? { signal } : {}),
            });
            return toolJson(JSON.parse(stdout));
          } catch {
            throw new Error("house_hunting_operation_failed");
          } finally {
            if (temporary) {
              const { unlink } = await import("node:fs/promises");
              await unlink(temporary);
            }
          }
        }),
    },
  ];
}

/** The mixed audience bank can only add bounded skill tools to social abilities. */
export function discordSessionTools(
  authored: readonly ToolDefinition[],
  systemTools: boolean,
  access?: DiscordSessionAccess,
): ToolDefinition[] {
  return [
    ...authored.filter(
      (tool) =>
        (systemTools || !["discord_server_action", "discord_tracking_project"].includes(tool.name)) &&
        (access?.privateContext !== false || SOCIAL_DISCORD_TOOLS.has(tool.name)),
    ),
    ...houseHuntingTools(access),
  ];
}

const SOCIAL_DISCORD_TOOLS = new Set([
  "generate_image",
  "generate_video",
  "youtube_search",
  "music_play",
  "music_queue",
  "music_skip",
  "music_pause",
  "music_resume",
  "music_stop",
  "music_now",
  "send_text_update",
  "discord_react",
  "discord_unreact",
  "discord_create_thread",
  "discord_join_thread",
  "discord_watch_start",
  "discord_watch_stop",
  "voice_join",
  "voice_leave",
  "draw_er_diagram",
  "draw_sequence_diagram",
  "observe_share",
  "pokeagent_join_mmo",
  "pokeagent_world",
  "pokeagent_guide",
  "pokeagent_stop",
  "pokeagent_observe",
  "pokeagent_recall",
]);

const householdQueues = new Map<string, Promise<unknown>>();
async function withHouseholdQueue<T>(home: string, work: () => Promise<T>): Promise<T> {
  const pending = (householdQueues.get(home) ?? Promise.resolve()).then(work, work);
  householdQueues.set(home, pending);
  try {
    return await pending;
  } finally {
    if (householdQueues.get(home) === pending) householdQueues.delete(home);
  }
}
