import type { ECDH, KeyObject } from "node:crypto";
import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { z } from "zod";
import { openHostedDiscord } from "@clankie/protocol/hosted-discord-crypto";
const ReplaySchema = z.array(z.object({ id: z.string(), expiresAtMs: z.number() }).strict()).max(2000);
/** Request admission is durable before effects, including across process restarts. No device records. */
export class HostedDiscordOperator {
  private readonly seen = new Map<string, number>();
  private readonly options: {
    tenantId: string;
    installationId: string;
    accountId: string;
    key: ECDH;
    verifyKeys: ReadonlyMap<string, KeyObject>;
    statePath: string;
    clock?: () => number;
    authorize(permit: string): Promise<number>;
  };
  constructor(options: HostedDiscordOperator["options"]) {
    this.options = options;
    try {
      for (const entry of ReplaySchema.parse(JSON.parse(readFileSync(options.statePath, "utf8"))))
        this.seen.set(entry.id, entry.expiresAtMs);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT")
        throw new Error("discord_web_admission_invalid");
    }
  }
  async accept(
    input: unknown,
    execute: (request: {
      method: "GET" | "POST";
      path: string;
      body: string | undefined;
      expiresAtMs: number;
      guard(): Promise<void>;
      current(): boolean;
    }) => Promise<Response>,
  ): Promise<Response> {
    const nowMs = this.options.clock?.() ?? Date.now();
    let opened: ReturnType<typeof openHostedDiscord>;
    try {
      opened = openHostedDiscord(input, { ...this.options, nowMs });
    } catch {
      return Response.json({ error: "unauthorized" }, { status: 401 });
    }
    try {
      if (opened.claims.sub !== this.options.accountId)
        return Response.json({ error: "unauthorized" }, { status: 401 });
      let approvedUntil = 0;
      const current = () =>
        Math.min(approvedUntil, opened.claims.exp * 1000) > (this.options.clock?.() ?? Date.now());
      const guard = async () => {
        if (opened.claims.exp * 1000 <= (this.options.clock?.() ?? Date.now()))
          throw new Error("discord_grant_revoked");
        approvedUntil = await this.options.authorize((input as { permit: string }).permit);
        if (!current()) throw new Error("discord_grant_revoked");
      };
      try {
        await guard();
      } catch {
        return Response.json({ error: "discord_grant_revoked" }, { status: 403 });
      }
      for (const [id, expiry] of this.seen) if (expiry <= nowMs) this.seen.delete(id);
      if (this.seen.has(opened.claims.jti)) return Response.json({ error: "replayed" }, { status: 409 });
      if (this.seen.size >= 2000) return Response.json({ error: "capacity" }, { status: 429 });
      this.seen.set(opened.claims.jti, opened.claims.exp * 1000);
      try {
        mkdirSync(dirname(this.options.statePath), { recursive: true, mode: 0o700 });
        const temp = `${this.options.statePath}.tmp`;
        writeFileSync(
          temp,
          JSON.stringify([...this.seen].map(([id, expiresAtMs]) => ({ id, expiresAtMs }))),
          { mode: 0o600, flush: true },
        );
        renameSync(temp, this.options.statePath);
        const directory = openSync(dirname(this.options.statePath), "r");
        try {
          fsyncSync(directory);
        } finally {
          closeSync(directory);
        }
      } catch {
        this.seen.delete(opened.claims.jti);
        return Response.json({ error: "unavailable" }, { status: 503 });
      }
      const response = await execute({ ...opened, expiresAtMs: opened.claims.exp * 1000, guard, current }),
        body = await response.text();
      if (Buffer.byteLength(body) > 2 * 1024 * 1024)
        return Response.json({ error: "response_too_large" }, { status: 502 });
      return Response.json(
        { sealed: opened.sealResponse({ status: response.status, body }) },
        { headers: { "cache-control": "no-store" } },
      );
    } finally {
      opened.destroy();
    }
  }
}
