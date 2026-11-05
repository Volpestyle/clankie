import { mkdtemp, open, rm } from "node:fs/promises";
import { constants } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import { DesktopPermissionCheckSchema, type DesktopPermissionCheck } from "@clankie/protocol/desktop-access";
import type { HerdrBinding } from "@clankie/protocol";
import { herdrCoreCall } from "./captain/herdr-core.ts";
import { nativeRequest } from "./herdr-native-request.ts";

const Created = z.object({
  result: z.object({
    layout: z.object({
      root: z.object({
        type: z.literal("pane"),
        pane_id: z.string().regex(/^w[\w]+:p[\w]+$/u),
      }),
    }),
  }),
});

/** One fixed diagnostic in a new owned terminal. No existing terminal receives input. */
export function createDesktopPermissionCheck(options: {
  binding: () =>
    | { kind: "herdr" | "desktop"; binding: HerdrBinding }
    | undefined
    | Promise<{ kind: "herdr" | "desktop"; binding: HerdrBinding } | undefined>;
  helper: string;
  platform?: string;
  timeoutMs?: number;
}) {
  let running = false;
  return async (guard: () => Promise<void>): Promise<DesktopPermissionCheck> => {
    const unavailable = (
      reason: Extract<DesktopPermissionCheck, { state: "unavailable" }>["reason"],
    ): DesktopPermissionCheck => ({ state: "unavailable", reason });
    if ((options.platform ?? process.platform) !== "darwin") return unavailable("unsupported");
    if (running) return unavailable("check_in_progress");
    running = true;
    try {
      const selected = structuredClone(await options.binding());
      if (!selected) return unavailable("terminal_unavailable");
      const binding = selected.binding;
      const current = async () => JSON.stringify(await options.binding()) === JSON.stringify(selected);
      const desktop = selected.kind === "desktop";
      let directory: string | undefined;
      let pane: string | undefined;
      const result = await (async (): Promise<DesktopPermissionCheck> => {
        try {
          directory = await mkdtemp(join(tmpdir(), "clankie-permission-check-"));
          const output = join(directory, "result.json");
          const nonce = randomUUID();
          // Preparation is complete. No launch after a revoked owner or changed binding.
          if (!(await current())) return unavailable("terminal_changed");
          await guard();
          let reply: unknown;
          try {
            reply = desktop
              ? await herdrCoreCall(binding.socketPath, "terminal.run", {
                  argv: [process.execPath, options.helper, output, nonce],
                  cwd: directory,
                  env: {},
                  keep: false,
                  rm: true,
                  no_parent: true,
                  no_notify: true,
                  // Unlabelled diagnostics are not adopted into the desktop window.
                  labels: {},
                })
              : await nativeRequest(
                  binding,
                  "layout.apply",
                  {
                    tab_label: "Desktop permission check",
                    focus: false,
                    root: {
                      type: "pane",
                      cwd: directory,
                      command: [process.execPath, options.helper, output, nonce],
                      env: {},
                    },
                  },
                  { timeoutMs: 2000 },
                );
          } catch {
            return unavailable("launch_unconfirmed");
          }
          if (desktop) {
            const created = z.object({ address: z.string().regex(/^t[0-9]+$/u) }).safeParse(reply);
            if (!created.success) return unavailable("launch_unconfirmed");
            pane = created.data.address;
          } else {
            const created = Created.safeParse(reply);
            if (!created.success) return unavailable("launch_unconfirmed");
            pane = created.data.result.layout.root.pane_id;
          }
          if (!(await current())) return unavailable("terminal_changed");
          const deadline = performance.now() + (options.timeoutMs ?? 12_000);
          while (performance.now() < deadline) {
            if (!(await current())) return unavailable("terminal_changed");
            try {
              const handle = await open(output, constants.O_RDONLY | constants.O_NOFOLLOW);
              let content: string;
              try {
                if (!(await handle.stat()).isFile()) return unavailable("invalid_observation");
                const bytes = Buffer.alloc(8193);
                const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
                if (bytesRead > 8192) return unavailable("invalid_observation");
                content = new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, bytesRead));
              } finally {
                await handle.close();
              }
              const parsed = z
                .strictObject({ nonce: z.literal(nonce), result: DesktopPermissionCheckSchema })
                .safeParse(JSON.parse(content));
              if (!parsed.success) return unavailable("invalid_observation");
              if (parsed.data.result.state === "observed") {
                const age = Date.now() - Date.parse(parsed.data.result.observation.observedAt);
                if (age < 0 || age > 10_000) return unavailable("invalid_observation");
              }
              return parsed.data.result;
            } catch (error) {
              if ((error as NodeJS.ErrnoException).code !== "ENOENT")
                return unavailable("invalid_observation");
            }
            await delay(50);
          }
          return unavailable("timed_out");
        } finally {
          // Only the exact newly created pane is ever closed. Never retry an uncertain creation.
          if (pane) {
            if (desktop) {
              await herdrCoreCall(binding.socketPath, "terminal.kill", { terminal: pane }).catch(() => {});
              await herdrCoreCall(binding.socketPath, "terminal.rm", { terminal: pane }).catch(() => {});
            } else
              await nativeRequest(binding, "pane.close", { pane_id: pane }, { timeoutMs: 2000 }).catch(
                () => {},
              );
          }
          if (directory) await rm(directory, { recursive: true, force: true });
        }
      })();
      // Cleanup also awaits the terminal. Never publish a result after rebinding.
      return (await current()) ? result : unavailable("terminal_changed");
    } finally {
      running = false;
    }
  };
}
