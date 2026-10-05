import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { createClankieApp } from "../../clankie/src/app.ts";
import { createStubCaptain } from "../../clankie/src/captain/port.ts";
import { runSupportCommand } from "../src/command/support.ts";
import { buildSupportCommands } from "../src/support-commands.ts";
import type { ClankieFaceShell } from "../src/shell/shell.ts";

it("CLI and console issue, list, pair and revoke owner support grants through real body HTTP", async () => {
  const dir = mkdtempSync(join(tmpdir(), "support-cli-body-"));
  const body = await createClankieApp({
    captain: createStubCaptain(),
    eventLogPath: join(dir, "events.jsonl"),
    deviceSessionKey: randomBytes(32),
    authenticateOperator: async (request) =>
      request.headers.get("authorization") === "Bearer fixture-owner" ? { operatorId: "owner" } : undefined,
  });
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const result = await body.app.fetch(
      new Request(`http://127.0.0.1${request.url}`, {
        method: request.method ?? "GET",
        headers: request.headers as Record<string, string>,
        ...(chunks.length ? { body: Buffer.concat(chunks) } : {}),
      }),
    );
    response.writeHead(result.status, Object.fromEntries(result.headers));
    response.end(Buffer.from(await result.arrayBuffer()));
  }).listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("test server did not bind");
  const options = {
    env: { CLANKIE_OPERATOR_TOKEN: "fixture-owner" },
    host: `http://127.0.0.1:${address.port}`,
  };
  const run = async (args: string[]) => {
    let output = "";
    expect(
      await runSupportCommand(args, {
        ...options,
        stdout: {
          write: (chunk) => {
            output += chunk;
          },
        },
      }),
    ).toBe(0);
    return JSON.parse(output);
  };
  try {
    const grant = await run(["create", "read-state", "--hours", "72", "--ref", "CLI support 1367"]);
    expect(grant).toMatchObject({ scope: "read-state", status: "active", supportRef: "CLI support 1367" });
    expect(Date.parse(grant.expiresAt) - Date.parse(grant.createdAt)).toBe(72 * 3_600_000);
    expect((await run(["list"])).grants).toEqual([grant]);
    expect(await run(["offer", grant.grantId])).toHaveProperty("deepLink");
    const results: string[] = [];
    const [command] = buildSupportCommands(options);
    const shell = {
      insertCommandResult: (_label: string, output: string, tone: string) => {
        expect(tone).toBe("success");
        results.push(output);
      },
    } as unknown as ClankieFaceShell;
    await command?.run(`revoke ${grant.grantId}`, shell);
    expect(JSON.parse(results[0] ?? "{}").status).toBe("revoked");
    expect((await run([])).grants[0].status).toBe("revoked");
    await expect(run(["create", "shell", "--hours", "73", "--ref", "invalid"])).rejects.toThrow("Usage:");
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    await body.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
