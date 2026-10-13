import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { z } from "zod";
import { readPrivateJson, writePrivateJson } from "../../../tui/bin/update-files.ts";
import type { WorkerAccountStatus, WorkerAccountHold } from "./harness-accounts.ts";
import type { AccountIdentityNotice } from "@clankie/protocol/worker-accounts";

/** Only non-secret identity metadata belongs here. Homes never own an account's preferences. */
const State = z.object({
  version: z.literal(1),
  machines: z.record(z.string(), z.string()).default({}),
  aliases: z.record(z.string(), z.string()),
  identities: z.record(z.string(), z.string()).default({}),
  homes: z.record(
    z.string(),
    z.object({ key: z.string(), identity: z.string(), seenAt: z.number().default(0) }),
  ),
  notices: z.array(
    z.object({
      id: z.string(),
      machine: z.string(),
      harness: z.enum(["claude", "codex"]),
      home: z.string(),
      before: z.string(),
      after: z.string(),
      message: z.string(),
      observedAt: z.string(),
      delivered: z.boolean(),
    }),
  ),
});
const empty = (): z.infer<typeof State> => ({
  version: 1,
  machines: {},
  aliases: {},
  identities: {},
  homes: {},
  notices: [],
});
const aliasKey = (machine: string, harness: string, label: string) =>
  JSON.stringify([machine, harness, label]);

/** A native account ID wins; otherwise the harness's normalized email identifies it. */
export function harnessAccountKey(account: WorkerAccountStatus): string | undefined {
  if (account.signedIn !== true) return undefined;
  const identity = account.identityId ?? account.chatgptAccountId ?? account.identity?.trim().toLowerCase();
  if (!identity) return undefined;
  return `account-${createHash("sha256")
    .update(JSON.stringify([account.harness, identity, account.organizationId ?? ""]))
    .digest("hex")
    .slice(0, 32)}`;
}

export class HarnessAccountIdentities {
  private state = empty();
  private readonly path: string | undefined;
  constructor(path?: string) {
    this.path = path;
    if (path && existsSync(path)) this.state = State.parse(readPrivateJson(path));
  }
  bindMachine(alias: string, physical: string) {
    this.state.machines[alias] = physical;
  }
  private machine(machine: string) {
    return this.state.machines[machine] ?? machine;
  }
  resolve(machine: string, harness: string, label: string): string {
    machine = this.machine(machine);
    return this.state.aliases[aliasKey(machine, harness, label)] ?? label;
  }
  private save() {
    if (!this.path) return;
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    writePrivateJson(this.path, State.parse(this.state));
  }
  group(
    machine: string,
    accounts: readonly WorkerAccountStatus[],
    holds: readonly WorkerAccountHold[],
    now: number,
  ): WorkerAccountStatus[] {
    machine = this.machine(machine);
    const groups = new Map<string, WorkerAccountStatus[]>();
    for (const account of accounts) {
      const key = harnessAccountKey(account);
      if (!key) {
        groups.set(JSON.stringify([account.harness, account.home]), [account]);
        continue;
      }
      const homeKey = JSON.stringify([machine, account.harness, account.home]);
      const previous = this.state.homes[homeKey];
      // A slow native read that started before a newer observation must not
      // manufacture a reverse re-sign or offer that stale home for a hire.
      if (previous && previous.seenAt > now && previous.key !== key) continue;
      const identity = account.identity ?? account.identityId ?? key;
      this.state.identities[key] = identity;
      if (previous && previous.key !== key && (account.harness === "claude" || account.harness === "codex")) {
        const id = randomUUID();
        const change =
          previous.identity === identity
            ? `changed the signed-in account or organization for ${identity}`
            : `changed from ${previous.identity} to ${identity}`;
        const message = `${account.harness === "claude" ? "Claude" : "Codex"} sign-in in ${account.home} ${change}. Preferences and usage stay with the account, not this folder. (${new Date(now).toISOString()})`;
        this.state.notices.push({
          id,
          machine,
          harness: account.harness,
          home: account.home,
          before: previous.identity,
          after: identity,
          message,
          observedAt: new Date(now).toISOString(),
          delivered: false,
        });
      }
      if (!previous || previous.seenAt <= now) this.state.homes[homeKey] = { key, identity, seenAt: now };
      for (const label of [account.label, ...(account.aliases ?? [])]) {
        this.state.aliases[aliasKey(machine, account.harness, label)] ??= key;
      }
      const members = groups.get(key) ?? [];
      members.push(account);
      groups.set(key, members);
    }
    this.state.notices = this.state.notices.slice(-64);
    this.save();
    return [...groups].map(([key, members]) => {
      const ordered = [...members].sort(
        (a, b) =>
          Number(b.usable) - Number(a.usable) ||
          Number(b.usage !== undefined) - Number(a.usage !== undefined) ||
          Number(b.tier !== undefined) - Number(a.tier !== undefined) ||
          a.home.localeCompare(b.home),
      );
      const chosen = ordered[0]!;
      // One identity has one limit pool, even when homes disagree briefly.
      const pool =
        members
          .filter((member) => member.usage !== undefined && member.headroom !== null)
          .sort((a, b) => a.headroom! - b.headroom!)[0] ?? chosen;
      if (!key.startsWith("account-")) return chosen;
      const aliases = Object.entries(this.state.aliases).flatMap(([binding, identity]) => {
        const [host, harness, label] = JSON.parse(binding) as string[];
        return host === machine && harness === chosen.harness && identity === key ? [label!] : [];
      });
      const hold = holds.find(
        (entry) =>
          this.machine(entry.machine) === machine &&
          entry.harness === chosen.harness &&
          this.resolve(machine, entry.harness, entry.label) === key,
      );
      const { held: _held, ...status } = chosen;
      return {
        ...status,
        headroom: pool.headroom,
        ...(pool.usage === undefined ? {} : { usage: pool.usage }),
        ...(pool.resetsAt === undefined ? {} : { resetsAt: pool.resetsAt }),
        usable: chosen.usable && pool.headroom !== 0,
        ...(pool.headroom === 0
          ? {
              reason: `Native ${chosen.harness} reports no available usage for this identity${pool.resetsAt ? ` until ${pool.resetsAt}` : ""}.`,
            }
          : {}),
        label: key,
        accountKey: key,
        aliases,
        homes: ordered.map((account) => ({ home: account.home, label: account.label })),
        ...(hold ? { held: hold.reason === undefined ? {} : { reason: hold.reason } } : {}),
      };
    });
  }
  aliases(machine: string): Record<string, string> {
    machine = this.machine(machine);
    return Object.fromEntries(
      Object.entries(this.state.aliases).flatMap(([binding, key]) => {
        const [host, harness, label] = JSON.parse(binding) as string[];
        return host === machine ? [[`${harness}:${label}`, key]] : [];
      }),
    );
  }
  names(machine: string): Record<string, string> {
    const keys = new Set(Object.values(this.aliases(machine)));
    return Object.fromEntries(Object.entries(this.state.identities).filter(([key]) => keys.has(key)));
  }
  notices(machine: string): AccountIdentityNotice[] {
    machine = this.machine(machine);
    return this.state.notices
      .filter((notice) => notice.machine === machine)
      .map(({ delivered: _delivered, ...notice }) => notice);
  }
  deliver(notify: ((message: string) => boolean) | undefined) {
    if (!notify) return;
    for (const notice of this.state.notices)
      if (!notice.delivered && notify(notice.message)) notice.delivered = true;
    this.save();
  }
}

// The captain and HTTP readers in the same service share one durable observer.
const registries = new Map<string, HarnessAccountIdentities>();
export function harnessAccountIdentities(path?: string): HarnessAccountIdentities {
  if (!path) return new HarnessAccountIdentities();
  let registry = registries.get(path);
  if (!registry) {
    registry = new HarnessAccountIdentities(path);
    registries.set(path, registry);
  }
  return registry;
}
