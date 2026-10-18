import { createServer } from "node:http";
import { expect, it } from "vitest";
import type { WorkConvention } from "@clankie/protocol/work-items";
import { trackerToolsFor } from "../src/tracker.ts";
import { createLinearBackend } from "../src/backends/linear.ts";

it("allows delegated Linear writes across projects of the saved team while preserving owner-device scope", async () => {
  const team = "d53265da-b742-43c3-9a13-7cac6506234e";
  const otherTeam = "11111111-1111-4111-8111-111111111111";
  const project = "bdfa8c5a-933d-4f59-abf7-db42f81e45d1";
  const kh2 = "b701962e-89aa-4685-a574-ebda25706d64";
  const alien = "22222222-2222-4222-8222-222222222222";
  const projects: Record<string, unknown> = {
    Clankie: { id: project, teams: [{ id: team }] },
    KH2: { id: kh2, teams: { nodes: [{ id: team.toUpperCase() }] } },
    Alien: { id: alien, teams: [{ id: otherTeam, name: "Vuhlp" }] },
    Unproven: { id: alien, teams: [{ name: "Vuhlp" }] },
    Missing: null,
  };
  const issues = {
    "VUH-2415": { id: "VUH-2415", title: "Crown", teamId: team, projectId: kh2 },
    "OTHER-1": { id: "OTHER-1", title: "Outside", teamId: otherTeam, projectId: alien },
  };
  const effects: { tool: string; args: Record<string, unknown> }[] = [];
  // Native connected-tool shapes over an actual HTTP boundary; no live provider writes.
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const { tool, args } = JSON.parse(Buffer.concat(chunks).toString()) as {
      tool: string;
      args: Record<string, unknown>;
    };
    response.setHeader("content-type", "application/json");
    if (tool === "get_team") response.end(JSON.stringify({ id: args.query === "OTHER" ? otherTeam : team }));
    else if (tool === "get_project") response.end(JSON.stringify(projects[String(args.query)] ?? null));
    else if (tool === "get_issue") response.end(JSON.stringify(issues[args.id as keyof typeof issues]));
    else if (["save_comment", "create_comment", "save_issue"].includes(tool)) {
      effects.push({ tool, args });
      response.end(JSON.stringify({ id: "saved", ...args }));
    } else {
      response.statusCode = 400;
      response.end(JSON.stringify({ error: "Unexpected tool" }));
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("No fixture address");
    const call = async (tool: string, args: Record<string, unknown>) => {
      const response = await fetch(`http://127.0.0.1:${address.port}`, {
        method: "POST",
        body: JSON.stringify({ tool, args }),
      });
      if (!response.ok) throw new Error(`Provider HTTP ${response.status}`);
      return response.json();
    };
    const convention: WorkConvention = {
      schemaVersion: 1,
      backend: "linear",
      decidedBy: "owner",
      decidedAt: "2026-10-18T05:45:00Z",
      linear: { team: "VUH", project: "Clankie" },
    };
    const worker = trackerToolsFor("/unused", convention, {
      linear: call,
      scopedWrites: true,
      linearWriteScope: "team",
    });
    await worker.call("save_comment", { issueId: "VUH-2415", body: "Reviewed" });
    await worker.call("create_comment", { issueId: "VUH-2415", body: "Alias" });
    await worker.call("save_issue", { id: "VUH-2415", title: "Reviewed crown" });
    await worker.call("save_issue", { title: "New KH2 work", project: "KH2", team: team.toUpperCase() });
    expect(effects).toHaveLength(4);
    expect(effects[3]).toMatchObject({ tool: "save_issue", args: { project: "KH2" } });
    // Removing a project stays within the issue's proven team too.
    await worker.call("save_issue", { id: "VUH-2415", project: null });
    const accepted = effects.length;
    for (const tool of ["save_comment", "create_comment", "save_issue"]) {
      await expect(
        worker.call(
          tool,
          tool === "save_issue"
            ? { id: "OTHER-1", title: "Refused" }
            : { issueId: "OTHER-1", body: "Refused" },
        ),
      ).rejects.toMatchObject({ code: "work_item_out_of_scope" });
    }
    await expect(worker.call("save_issue", { title: "Refused", team: "OTHER" })).rejects.toMatchObject({
      code: "work_item_out_of_scope",
    });
    for (const name of ["Alien", "Unproven", "Missing"]) {
      await expect(worker.call("save_issue", { title: "Refused", project: name })).rejects.toMatchObject({
        code: "work_item_out_of_scope",
      });
      await expect(worker.call("save_issue", { id: "VUH-2415", project: name })).rejects.toMatchObject({
        code: "work_item_out_of_scope",
      });
    }
    expect(effects).toHaveLength(accepted);
    // The default scoped setting used by owner-device writes still requires the saved project.
    const owner = trackerToolsFor("/unused", convention, { linear: call, scopedWrites: true });
    await expect(owner.call("save_comment", { issueId: "VUH-2415", body: "Refused" })).rejects.toMatchObject({
      code: "work_item_out_of_scope",
    });
    await expect(
      createLinearBackend({ team: "VUH", project: "Clankie", call, scopedWrites: true }).update("VUH-2415", {
        title: "Refused",
      }),
    ).rejects.toMatchObject({ code: "work_item_out_of_scope" });
    expect(effects).toHaveLength(accepted);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
