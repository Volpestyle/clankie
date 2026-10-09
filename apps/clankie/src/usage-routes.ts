import { createHash } from "node:crypto";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import {
  USAGE_PATH,
  USAGE_SETTINGS_PATH,
  UpdateUsageSettingsSchema,
  type UsageAccount,
  type UsageReport,
  type UsageSettingsSnapshot,
} from "@clankie/protocol/worker-accounts";
import type { ClankieSettings, SettingsStore } from "@clankie/settings";
import type { MachineWorkerAccounts } from "./captain/harness-accounts.ts";
import { CLAUDE_USAGE_MIN_VERSION, usageHeadroom } from "./captain/harness-usage.ts";
import { allocateAccounts } from "./captain/account-allocation.ts";

/** Meters poll; spawning every profile's CLI on each poll would load the Mac for nothing. */
const USAGE_CACHE_MS = 60_000;
/** A signed-in account whose latest read came back empty keeps its last reading this long, with its real age. */
const USAGE_LAST_GOOD_MS = 30 * 60_000;

function usageSettings(settings: ClankieSettings): UsageSettingsSnapshot {
  const display = { overlay: settings.usage.overlay };
  const allocation = {
    runOutWarning: settings.usage.runOutWarning,
    runOutWarningHours: settings.usage.runOutWarningHours,
  };
  return {
    display,
    allocation,
    revision: createHash("sha256").update(JSON.stringify({ display, allocation })).digest("hex"),
  };
}

function usageAccounts(report: MachineWorkerAccounts, now: number): UsageAccount[] {
  return report.accounts.flatMap((account) => {
    if (account.harness !== "claude" && account.harness !== "codex") return [];
    const observed = account.usage === undefined ? undefined : Date.parse(account.usage.observedAt);
    const reason =
      account.reason ??
      (account.usage === undefined && account.signedIn === true
        ? account.harness === "claude"
          ? `Claude Code did not report usage for this profile (it needs Claude Code ${CLAUDE_USAGE_MIN_VERSION} or newer)`
          : "Codex did not report usage for this account"
        : undefined);
    return [
      {
        harness: account.harness,
        label: account.label,
        signedIn: account.signedIn,
        headroom: account.headroom,
        ...(account.identity === undefined ? {} : { identity: account.identity }),
        ...(account.plan === undefined ? {} : { plan: account.plan }),
        ...(account.usage === undefined ? {} : { usage: account.usage }),
        ...(observed === undefined ? {} : { ageSeconds: Math.max(0, Math.floor((now - observed) / 1000)) }),
        ...(account.held === undefined ? {} : { held: account.held }),
        ...(reason === undefined ? {} : { reason }),
      },
    ];
  });
}

/**
 * Usage meters for this machine's registered accounts (VUH-1961), and the
 * owner's choice of where they show. Readings are shared for a minute across
 * every surface that polls; `?refresh=1` reads again now.
 */
export function createUsageRoutes(
  authorize: (request: Request) => Promise<true | "authentication_required" | "forbidden">,
  settings: Pick<SettingsStore, "load"> & Partial<Pick<SettingsStore, "update">>,
  read: (() => Promise<MachineWorkerAccounts>) | undefined,
  clock: () => number = Date.now,
): Hono {
  const app = new Hono();
  let cached: { at: number; report: Promise<MachineWorkerAccounts> } | undefined;
  const lastGood = new Map<string, NonNullable<MachineWorkerAccounts["accounts"][number]["usage"]>>();
  // One CLI can miss a read (a vendor timeout, a busy Mac); a meter should not blank for it.
  const steady = (report: MachineWorkerAccounts, now: number): MachineWorkerAccounts => ({
    ...report,
    accounts: report.accounts.map((account) => {
      const key = `${account.harness}:${account.label}:${account.identity ?? ""}`;
      if (account.usage) {
        lastGood.set(key, account.usage);
        return account;
      }
      const previous = lastGood.get(key);
      return account.signedIn === true &&
        previous &&
        now - Date.parse(previous.observedAt) < USAGE_LAST_GOOD_MS
        ? { ...account, usage: previous, headroom: usageHeadroom(previous, now) }
        : account;
    }),
  });
  const report = (refresh: boolean) => {
    const now = clock();
    if (!read) throw new Error("Usage is unavailable on this body");
    if (!cached || refresh || now - cached.at >= USAGE_CACHE_MS) {
      const pending = read();
      cached = { at: now, report: pending };
      pending.catch(() => {
        if (cached?.report === pending) cached = undefined;
      });
    }
    return cached.report;
  };
  for (const path of [USAGE_PATH, USAGE_SETTINGS_PATH])
    app.use(path, async (context, next) => {
      context.header("cache-control", "no-store");
      const authority = await authorize(context.req.raw);
      if (authority !== true)
        return context.json({ error: authority }, authority === "forbidden" ? 403 : 401);
      await next();
    });
  app.get(USAGE_PATH, async (context) => {
    if (!read) return context.json({ error: "usage_unavailable" }, 503);
    const current = await settings.load();
    let machine: MachineWorkerAccounts;
    try {
      machine = await report(context.req.query("refresh") === "1");
    } catch (error) {
      return context.json(
        { error: "usage_failed", detail: error instanceof Error ? error.message : "Unavailable" },
        409,
      );
    }
    const now = clock();
    machine = steady(machine, now);
    const unavailable = Object.fromEntries(
      Object.entries(machine.unavailable ?? {}).filter(
        ([harness]) => harness === "claude" || harness === "codex",
      ),
    );
    const body: UsageReport = {
      schemaVersion: 1,
      machine: machine.machine,
      observedAt: machine.observedAt,
      accounts: usageAccounts(machine, now),
      ...(Object.keys(unavailable).length ? { unavailable } : {}),
      settings: usageSettings(current),
      allocation: allocateAccounts(machine, now),
    };
    return context.json(body);
  });
  app.get(USAGE_SETTINGS_PATH, async (context) => context.json(usageSettings(await settings.load())));
  app.post(USAGE_SETTINGS_PATH, bodyLimit({ maxSize: 4096 }), async (context) => {
    if (!settings.update) return context.json({ error: "settings_unavailable" }, 503);
    const input = UpdateUsageSettingsSchema.safeParse(await context.req.json().catch(() => null));
    if (!input.success) return context.json({ error: "invalid_usage_settings" }, 400);
    let before: string | undefined;
    try {
      const updated = await settings.update(
        (current) => {
          if (usageSettings(current).revision !== input.data.expectedRevision)
            throw new Error("Usage settings changed");
          before = JSON.stringify(current);
          return {
            ...current,
            usage: {
              ...current.usage,
              ...(input.data.display?.overlay === undefined ? {} : { overlay: input.data.display.overlay }),
              ...(input.data.allocation?.runOutWarning === undefined
                ? {}
                : { runOutWarning: input.data.allocation.runOutWarning }),
              ...(input.data.allocation?.runOutWarningHours === undefined
                ? {}
                : { runOutWarningHours: input.data.allocation.runOutWarningHours }),
            },
          };
        },
        async () => {
          if ((await authorize(context.req.raw)) !== true) throw new Error("Owner authority changed");
          if (JSON.stringify(await settings.load()) !== before) throw new Error("Settings changed");
        },
      );
      return context.json(usageSettings(updated));
    } catch {
      return context.json({ error: "usage_settings_conflict" }, 409);
    }
  });
  return app;
}
