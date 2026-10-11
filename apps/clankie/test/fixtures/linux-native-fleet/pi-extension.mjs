import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { createPiWorkerFleet } from "../../../src/captain/pi-worker-fleet.mjs";

// Runs inside the real native Pi TUI. Calls native registered definitions at
// startup; no model, provider account or headless agent participates.
export default function proof(pi) {
  const definitions = new Map();
  const register = pi.registerTool.bind(pi);
  pi.registerTool = (definition) => {
    definitions.set(definition.name, definition);
    return register(definition);
  };
  pi.on("project_trust", (_event, ctx) => {
    assert.ok(ctx.cwd.startsWith("/tmp/clankie-proof-"));
    return { trusted: "yes", persist: false };
  });
  createPiWorkerFleet(pi, {
    transport: new StdioClientTransport({
      command: process.execPath,
      args: [process.env.PROOF_FLEET_BRIDGE],
      env: Object.fromEntries(Object.entries(process.env).filter(([, value]) => value !== undefined)),
      cwd: process.cwd(),
      stderr: "pipe",
    }),
  });
  pi.on("session_start", async (_event, ctx) => {
    try {
      assert.equal(ctx.mode, "tui");
      assert.equal(ctx.isProjectTrusted(), true);
      const call = async (name, args) => {
        assert.ok(definitions.has(name), `Native catalog missing ${name}`);
        const result = await definitions.get(name).execute("proof", args, undefined, undefined, ctx);
        assert.notEqual(result.details?.mcp?.isError, true, JSON.stringify(result));
        return result;
      };
      const discovery = await call("clankie_tools", { names: ["proof_read"] });
      assert.match(JSON.stringify(discovery), /proof_read/);
      const read = await call("clankie_call", { name: "proof_read", arguments: {} });
      assert.match(JSON.stringify(read), /owned Linux fixture data/);
      const report = await call("message_clankie", { text: "Linux native Pi kernel proof complete" });
      assert.match(JSON.stringify(report), /stored/);
      await writeFile(
        process.env.PROOF_RESULT,
        JSON.stringify({
          pid: process.pid,
          mode: ctx.mode,
          session: ctx.sessionManager.getSessionId(),
          catalog: [...definitions.keys()],
          discovery,
          read,
          report,
        }) + "\n",
      );
    } catch (error) {
      await writeFile(process.env.PROOF_RESULT, JSON.stringify({ error: String(error) }) + "\n");
    }
  });
}
