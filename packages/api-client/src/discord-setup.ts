import {
  DiscordSettingsSchema,
  type DiscordDirectoryEntry,
  type DiscordDirectoryRequest,
  type DiscordDirectorySnapshot,
  type DiscordSetupSentence,
  type DiscordSettingsSnapshot,
} from "@clankie/protocol";
import type { ClankieApiClient } from "./index.ts";

export type DiscordSetupApi = Pick<
  ClankieApiClient,
  "discordSettings" | "discordDirectory" | "updateDiscordSettings"
> &
  Partial<Pick<ClankieApiClient, "discordSetupTestPost">>;
export type DiscordSetupPicker = Extract<DiscordSetupSentence["parts"][number], { kind: "picker" }>;
export type DiscordAccessChoice = "deny" | "owner_only" | "allowlist" | "guild_members";
export interface DiscordPickerSelection {
  unchanged?: boolean;
  ids?: string[];
  visible?: boolean;
  access?: DiscordAccessChoice;
}
export interface DiscordSetupView {
  snapshot: DiscordSettingsSnapshot;
  directories: DiscordDirectorySnapshot[];
  sentences: {
    id: DiscordSetupSentence["id"];
    text: string;
    help: string;
    checks: { kind: string; label: string; status: "passed" | "failed" | "not_checked" }[];
  }[];
}

export function discordSetupPickers(sentence: DiscordSetupSentence): DiscordSetupPicker[] {
  return sentence.parts.filter((part): part is DiscordSetupPicker => part.kind === "picker");
}
export function discordSetupLabel(snapshot: DiscordSettingsSnapshot, key: string): string {
  return snapshot.setup?.definition.choiceLabels[key] ?? key.replaceAll("_", " ");
}
export function discordPickerIds(snapshot: DiscordSettingsSnapshot, part: DiscordSetupPicker): string[] {
  return [
    ...new Set(
      part.fields.flatMap((field) => {
        const value = snapshot.settings[field];
        return Array.isArray(value) ? value : typeof value === "string" ? [value] : [];
      }),
    ),
  ];
}
function entries(
  view: Pick<DiscordSetupView, "directories">,
  kind: DiscordDirectoryRequest["kind"],
  admitted: (entry: DiscordDirectoryEntry) => boolean = () => true,
) {
  return [
    ...new Map(
      view.directories
        .filter((directory) => directory.kind === kind)
        .flatMap((directory) => directory.entries)
        .filter(admitted)
        .map((entry) => [entry.id, entry]),
    ).values(),
  ];
}
export function discordPickerEntries(
  view: DiscordSetupView,
  part: DiscordSetupPicker,
  access?: DiscordAccessChoice,
): DiscordDirectoryEntry[] {
  const serverIds =
    part.serverFields && new Set(discordPickerIds(view.snapshot, { ...part, fields: part.serverFields }));
  const admitted = (entry: DiscordDirectoryEntry) =>
    !serverIds || (!!entry.guildId && serverIds.has(entry.guildId));
  if (part.picker === "server" || access === "guild_members") return entries(view, "servers");
  if (part.picker === "channels")
    return entries(view, "channels", admitted).filter((entry) => !["category", "other"].includes(entry.kind));
  if (access === "allowlist")
    return entries(view, "people", admitted).filter((entry) => entry.kind === "person");
  return [];
}
export function discordDirectoryEntryLabel(view: DiscordSetupView, entry: DiscordDirectoryEntry): string {
  const server = entries(view, "servers").find((item) => item.id === entry.guildId);
  return `${entry.kind === "server" || entry.kind === "person" || entry.kind === "bot" ? "" : "#"}${entry.name}${server ? ` · ${server.name}` : ""}`;
}
/** Exact names or numbered picker choices; IDs remain an Advanced concern. */
export function discordPickByName(
  view: DiscordSetupView,
  choices: DiscordDirectoryEntry[],
  input: string,
): DiscordDirectoryEntry {
  const index = /^@[1-9]\d*$/u.test(input) ? Number(input.slice(1)) - 1 : undefined;
  const matches =
    index === undefined
      ? choices.filter((entry) =>
          [entry.name, `#${entry.name}`, discordDirectoryEntryLabel(view, entry)].some(
            (name) => name.toLocaleLowerCase() === input.toLocaleLowerCase(),
          ),
        )
      : choices.slice(index, index + 1);
  if (matches.length !== 1)
    throw new Error(
      matches.length
        ? `“${input}” is ambiguous. Use a numbered choice from discord setup choices.`
        : `“${input}” is not in the available picker list. Inspect discord setup choices.`,
    );
  return matches[0]!;
}

function pickerText(view: DiscordSetupView, part: DiscordSetupPicker): string {
  const { snapshot } = view;
  const label = (key: string) => discordSetupLabel(snapshot, key);
  const named = (ids: string[], kind: DiscordDirectoryRequest["kind"], unavailable: string) =>
    ids
      .map((id) => {
        const entry = entries(view, kind).find((item) => item.id === id);
        return entry ? discordDirectoryEntryLabel(view, entry) : label(unavailable);
      })
      .join(", ");
  if (part.picker === "team_visibility")
    return label(snapshot.settings[part.fields[0]!] === false ? "team_hidden" : "team_visible");
  if (part.picker === "server") {
    const ids = discordPickerIds(snapshot, part);
    return ids.length ? named(ids, "servers", "unavailable_server") : label("no_server");
  }
  if (part.picker === "channels") {
    const ids = discordPickerIds(snapshot, part);
    return ids.length
      ? named(ids, "channels", "unavailable_room")
      : label(
          part.enables?.some((enable) => snapshot.settings[enable.field] === true) ? "all_rooms" : "no_rooms",
        );
  }
  const fields = part.accessFields;
  if (!fields) return label("computer_access");
  const people = snapshot.settings[fields.people] as string[];
  const servers = snapshot.settings[fields.servers] as string[];
  const channels = snapshot.settings[fields.channels] as string[];
  const granted = [
    people.length ? named(people, "people", "unavailable_person") : "",
    servers.length ? named(servers, "servers", "unavailable_server") : "",
    channels.length ? named(channels, "channels", "unavailable_room") : "",
  ].filter(Boolean);
  if (!granted.length) return label("deny");
  if (
    people.length === 1 &&
    people[0] === snapshot.settings.ownerUserId &&
    !servers.length &&
    !channels.length
  )
    return label("owner_only");
  return granted.join("; ");
}
function render(view: DiscordSetupView): DiscordSetupView {
  const { snapshot } = view;
  const setup = snapshot.setup!;
  const hostChecks = view.directories.some(
    (directory) => directory.state === "disconnected" || directory.state === "unavailable",
  )
    ? setup.checks?.map((check) => ({ ...check, status: "not_checked" as const }))
    : setup.checks;
  view.sentences = setup.definition.sentences.map((sentence) => ({
    id: sentence.id,
    text: sentence.parts
      .map((part) =>
        part.kind === "text"
          ? part.text
          : part.kind === "machine"
            ? setup.machineName
            : pickerText(view, part),
      )
      .join(""),
    help: sentence.help,
    checks: sentence.checks.map((kind) => ({
      kind,
      label: discordSetupLabel(snapshot, kind),
      status:
        hostChecks?.find((check) => check.sentenceId === sentence.id && check.kind === kind)?.status ??
        ((kind === "account" &&
          view.directories.some(
            (directory) => directory.kind === "servers" && directory.state === "connected",
          )) ||
        (kind === "view_channel" &&
          discordSetupPickers(sentence).some(
            (part) =>
              part.picker === "channels" &&
              discordPickerIds(snapshot, part).length > 0 &&
              discordPickerIds(snapshot, part).every((id) =>
                entries(view, "channels").some((entry) => entry.id === id),
              ),
          ))
          ? "passed"
          : "not_checked"),
    })),
  }));
  return view;
}

/** One client-side projection and writer used by terminal, phone and web surfaces. */
export class DiscordSetupClient {
  private readonly api: DiscordSetupApi;
  constructor(api: DiscordSetupApi) {
    this.api = api;
  }
  /** The same host-bound value used in a sentence and its inline picker button. */
  pickerText(view: DiscordSetupView, part: DiscordSetupPicker): string {
    return pickerText(view, part);
  }
  /** Called only by an explicit owner action; never from read or picker application. */
  async testPost(view: DiscordSetupView, room: DiscordDirectoryEntry) {
    if (!view.snapshot.setup?.testPostAvailable || !this.api.discordSetupTestPost)
      throw new Error("This host does not offer a Discord setup test post.");
    if (
      !room.guildId ||
      !["text", "announcement"].includes(room.kind) ||
      !entries(view, "channels").some((entry) => entry.id === room.id && entry.guildId === room.guildId)
    )
      throw new Error("Choose an available text room from the connected account.");
    return this.api.discordSetupTestPost({
      guildId: room.guildId,
      channelId: room.id,
      expectedRevision: view.snapshot.revision,
    });
  }
  private async directory(
    query: Pick<DiscordDirectoryRequest, "kind" | "guildId">,
  ): Promise<DiscordDirectorySnapshot> {
    const result = await this.api.discordDirectory({ ...query, limit: 200 });
    const combined = { ...result, entries: [...result.entries] };
    const cursors = new Set<string>();
    let page = result;
    while (page.hasMore) {
      if (!page.nextCursor || cursors.has(page.nextCursor))
        throw new Error("Discord picker pagination did not advance.");
      cursors.add(page.nextCursor);
      page = await this.api.discordDirectory({ ...query, limit: 200, after: page.nextCursor });
      if (page.body !== result.body) throw new Error("The connected Discord account changed. Reopen setup.");
      combined.entries.push(...page.entries);
      if (page.state !== "connected") {
        combined.state = page.state;
        combined.reason = page.reason;
      }
      if (page.state === "unavailable" || page.state === "disconnected") {
        combined.entries = [];
        break;
      }
    }
    combined.hasMore = false;
    delete combined.nextCursor;
    return combined;
  }
  async read(input?: DiscordSettingsSnapshot): Promise<DiscordSetupView> {
    const snapshot = input ?? (await this.api.discordSettings());
    if (!snapshot.setup)
      throw new Error("This host does not provide the shared Discord settings definition yet.");
    const servers = await this.directory({ kind: "servers" });
    const serverIds = new Set(
      snapshot.setup.definition.sentences.flatMap((sentence) =>
        discordSetupPickers(sentence)
          .filter((part) => part.picker === "server")
          .flatMap((part) => discordPickerIds(snapshot, part)),
      ),
    );
    const directories = [servers];
    for (const guildId of serverIds) {
      if (!servers.entries.some((entry) => entry.id === guildId)) continue;
      directories.push(
        ...(await Promise.all([
          this.directory({ kind: "channels", guildId }),
          this.directory({ kind: "people", guildId }),
        ])),
      );
    }
    if (directories.some((directory) => directory.body !== servers.body))
      throw new Error("The connected Discord account changed. Reopen setup.");
    return render({ snapshot, directories, sentences: [] });
  }
  async apply(
    view: DiscordSetupView,
    sentenceId: string,
    pickerIndex: number,
    selection: DiscordPickerSelection,
  ): Promise<DiscordSetupView> {
    return this.applySentence(view, sentenceId, [{ pickerIndex, selection }]);
  }
  async applySentence(
    view: DiscordSetupView,
    sentenceId: string,
    selections: { pickerIndex: number; selection: DiscordPickerSelection }[],
  ): Promise<DiscordSetupView> {
    const { snapshot } = view;
    const sentence = snapshot.setup!.definition.sentences.find((item) => item.id === sentenceId);
    const settings = { ...snapshot.settings };
    const fields = snapshot.setup!.definition.advancedGroups.flatMap((group) => group.fields);
    const write = (field: keyof typeof settings, value: unknown) => {
      (settings as Record<string, unknown>)[field] = value;
    };
    for (const { pickerIndex, selection } of selections) {
      if (selection.unchanged) continue;
      const part = sentence && discordSetupPickers(sentence)[pickerIndex];
      if (!sentence || !part) throw new Error("This host does not provide that Discord sentence picker.");
      if (part.picker === "team_visibility") {
        if (typeof selection.visible !== "boolean")
          throw new Error("Choose whether the team’s rooms show up or stay hidden.");
        for (const field of part.fields) write(field, selection.visible);
      } else if (part.picker === "computer_access") {
        if (sentence.explicitComputerAccess !== true || !part.accessFields)
          throw new Error("Computer access needs its own explicit choice and host bindings.");
        const ids =
          selection.access === "owner_only"
            ? snapshot.settings.ownerUserId
              ? [snapshot.settings.ownerUserId]
              : undefined
            : (selection.ids ?? []);
        if (!ids) throw new Error("Set the owner in Advanced before choosing Only me.");
        if (
          !selection.access ||
          !["deny", "owner_only", "allowlist", "guild_members"].includes(selection.access)
        )
          throw new Error("Choose computer access explicitly.");
        if (selection.access === "allowlist" || selection.access === "guild_members")
          this.validateIds(view, part, ids, selection.access);
        if ((selection.access === "allowlist" || selection.access === "guild_members") && !ids.length)
          throw new Error("Choose at least one person or server, or choose Nobody.");
        write(
          part.accessFields.people,
          selection.access === "owner_only" || selection.access === "allowlist" ? ids : [],
        );
        write(part.accessFields.servers, selection.access === "guild_members" ? ids : []);
        write(part.accessFields.channels, []);
      } else {
        const ids = selection.ids ?? [];
        this.validateIds(view, part, ids);
        if (part.picker === "server" && ids.length !== 1) throw new Error("Choose one server.");
        const choices = discordPickerEntries(view, part);
        for (const field of part.fields) {
          const metadata = fields.find((item) => item.key === field);
          const accepted = ids.filter(
            (id) =>
              !metadata?.directoryKinds ||
              metadata.directoryKinds.includes(choices.find((entry) => entry.id === id)!.kind),
          );
          write(field, metadata?.kind === "ids" ? accepted : accepted[0]);
        }
        for (const enable of part.enables ?? [])
          write(
            enable.field,
            ids.some(
              (id) => !enable.kinds || enable.kinds.includes(choices.find((entry) => entry.id === id)!.kind),
            ),
          );
      }
    }
    const saved = await this.api.updateDiscordSettings({
      expectedRevision: snapshot.revision,
      settings: DiscordSettingsSchema.parse(settings),
    });
    return this.read(saved);
  }
  private validateIds(
    view: DiscordSetupView,
    part: DiscordSetupPicker,
    ids: string[],
    access?: DiscordAccessChoice,
  ) {
    const choices = discordPickerEntries(view, part, access);
    if (ids.some((id) => !choices.some((entry) => entry.id === id)))
      throw new Error("The selection is not in the connected account’s picker list. Reopen setup.");
  }
}
