import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import type { ProjectReview } from "@clankie/protocol/reviews";
import { createClankieApp } from "../src/app.ts";
import { createStubCaptain } from "../src/captain/port.ts";
import { occupantIdForHerdrSession } from "../src/captain/herdr-census.ts";
import type { HerdrAgentSnapshot } from "../src/captain/herdr-watch.ts";
import { ReviewGate } from "../src/captain/review-gate.ts";
import type { LocalFleetIdentity } from "../src/local-fleet-link.ts";
import { fleetLinkFetch } from "../src/fleet-link.ts";
import {
  createReviewTools,
  readCandidatePatch,
} from "../../../integrations/claude-plugin/worker/bin/review-tools.mjs";
import { runReviewCommand } from "../../tui/src/command/review.ts";

// VUH-2616 / ADR 0287: author → reviewer → CHANGES → resubmit → APPROVE, with
// no lead relay. Real git produces and hashes the patches; the real worker
// bridge tools, seat and operator routes, fleet-link allowlist, review store
// and owner CLI carry them. Herdr's view of the two seats and the delivery
// transport are the only fixtures.

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));

function repository() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "review-gate-")));
  roots.push(root);
  const run = (...args: string[]) =>
    execFileSync("git", args, {
      cwd: root,
      encoding: "utf8",
      env: {
        ...process.env,
        GIT_AUTHOR_DATE: "2026-10-21T12:00:00Z",
        GIT_COMMITTER_DATE: "2026-10-21T12:00:00Z",
      },
    }).trim();
  run("init", "-q", "-b", "main");
  run("config", "user.email", "test@example.invalid");
  run("config", "user.name", "Test");
  writeFileSync(join(root, "app.ts"), "export const answer = 41;\n");
  writeFileSync(join(root, "other.ts"), "export const other = 1;\n");
  run("add", ".");
  run("commit", "-q", "-m", "base");
  run("update-ref", "refs/remotes/origin/main", "HEAD");
  run("switch", "-q", "-c", "feature");
  const commit = (file: string, text: string, message: string) => {
    writeFileSync(join(root, file), text);
    run("commit", "-q", "-am", message);
  };
  return { root, run, commit };
}

const seat = (name: string, pane: string, harness: string): HerdrAgentSnapshot => ({
  paneId: `pc/${pane}`,
  terminalId: `pc/term_${name}`,
  agent: harness,
  status: "idle",
  title: name,
  session: { source: `herdr:${harness}`, kind: "id", value: `session-${name}` },
});

it("holds landing until the reviewer approves the exact patch, across CHANGES and a resubmit", async () => {
  const repo = repository();
  repo.commit("app.ts", "export const answer = 42;\n", "fix the answer");
  const author = seat("author", "w1:p1", "claude");
  const reviewer = seat("reviewer", "w1:p2", "codex");
  const seats = [author, reviewer];
  let review: ProjectReview | undefined = { role: "reviewer" };
  const delivered: { seatId: string; text: string; conversationId: string | undefined }[] = [];
  const leadNotices: string[] = [];
  const state = mkdtempSync(join(tmpdir(), "review-state-"));
  roots.push(state);
  const gate = new ReviewGate({
    path: join(state, "reviews", "candidates.json"),
    review: async () => review,
    seat: async (pane) => seats.find((entry) => entry.paneId === pane),
    resolve: async (id) => seats.find((entry) => entry.terminalId === id),
    seatProject: async (agent) => (agent === author ? "clankie" : undefined),
    directoryProject: async (directory) => (directory === repo.root ? "clankie" : undefined),
    reviewers: async () => [reviewer],
    lead: (agent) => (agent === author ? { conversationId: "lead-chat" } : undefined),
    deliver: async (seatId, text, conversationId) => {
      delivered.push({ seatId, text, conversationId });
      return { outcome: "delivered", deliveryStage: "delivered" };
    },
    notifyLead: async (_owner, text) => void leadNotices.push(text),
  });
  // Keyed by a test header: the body limiter rebuilds a POST request object.
  const identities = new Map<string, LocalFleetIdentity>();
  const service = await createClankieApp({
    captain: createStubCaptain({ reviews: gate }),
    fleetLinks: {
      identity: (request) => identities.get(request.headers.get("x-test-seat") ?? ""),
      authenticate: () => "pc",
    },
    authenticateOperator: async () => ({ operatorId: "owner", steerSourceLane: "tui" }),
  });
  try {
    // Each seat's bridge reaches only its own pane, through the fleet link, with its native proof.
    const linkFetch = fleetLinkFetch(service.app.fetch);
    const toolsFor = (agent: HerdrAgentSnapshot) =>
      createReviewTools({
        cwd: () => repo.root,
        patchDirectory: join(state, `patches-${agent.title}`),
        request: async (route, suffix = "", init) => {
          const pane = agent.paneId.slice(3);
          const request = new Request(
            `http://localhost/v1/fleet/seats/${encodeURIComponent(pane)}/${route}${suffix}`,
            { ...init, headers: { "content-type": "application/json", "x-test-seat": pane } },
          );
          identities.set(pane, {
            fleet: "pc",
            pane,
            validate: async () => true,
            projectProof: async () => ({
              fleet: "pc",
              pane,
              nativeOccupantId: occupantIdForHerdrSession(agent.session!),
              binding: { socketPath: "pipe", session: "default" },
              processes: [{ pid: 2, startTime: "now" }],
              shell: { pid: 1, startTime: "now" },
            }),
          });
          return linkFetch(request);
        },
      });
    const authorTools = toolsFor(author);
    const reviewerTools = toolsFor(reviewer);
    const result = (value: unknown) => {
      const content = (value as { content: { text: string }[]; isError?: boolean }).content[0]!.text;
      return { isError: (value as { isError?: boolean }).isError === true, body: JSON.parse(content) };
    };
    const owner = (args: string[]) =>
      runReviewCommand(args, {
        env: { CLANKIE_OPERATOR_TOKEN: "owner-token" },
        host: "http://localhost",
        fetchImpl: async (input: RequestInfo | URL, init?: RequestInit) =>
          service.app.fetch(new Request(input, init)),
      });

    // The author submits; the service hashes the bytes it stores and sends them to the reviewer directly.
    const first = result(
      await authorTools.submit({
        summary: "Fix the answer",
        issue: "VUH-2616",
        evidence: ["clankie://evidence/x"],
      }),
    );
    expect(first.isError, JSON.stringify(first.body)).toBe(false);
    const candidate = first.body.candidate;
    expect(candidate).toMatchObject({
      status: "awaiting_review",
      projectId: "clankie",
      patchId: readCandidatePatch(repo.root).patchId,
      files: ["app.ts"],
      author: { seatId: "pc/term_author" },
      reviewer: { seatId: "pc/term_reviewer", deliveryStage: "delivered" },
    });
    expect(delivered).toHaveLength(1);
    expect(delivered[0]).toMatchObject({ seatId: "pc/term_reviewer", conversationId: "lead-chat" });
    expect(delivered[0]!.text).toContain(candidate.patchId);
    expect(leadNotices).toEqual([]);
    expect((await owner(["status", "--directory", repo.root])).body).toMatchObject({
      required: true,
      status: "awaiting_review",
      landable: false,
    });

    // The reviewer reads exactly the hashed bytes.
    const read = result(await reviewerTools.read({ candidateId: candidate.id }));
    expect(readFileSync(read.body.patchFile)).toEqual(readCandidatePatch(repo.root).patch);

    // Only the project's reviewer decides, and only for the patch it read.
    expect(
      result(
        await authorTools.verdict({
          candidateId: candidate.id,
          patchId: candidate.patchId,
          verdict: "approve",
        }),
      ).body.error,
    ).toBe("not_reviewer");
    expect(
      result(
        await reviewerTools.verdict({
          candidateId: candidate.id,
          patchId: "0".repeat(40),
          verdict: "approve",
        }),
      ).body.error,
    ).toBe("patch_id_mismatch");

    // CHANGES with specifics reaches the author and the lead; landing stays held.
    const changes = result(
      await reviewerTools.verdict({
        candidateId: candidate.id,
        patchId: candidate.patchId,
        verdict: "changes",
        findings: ["other.ts still exports the stale value"],
      }),
    );
    expect(changes.body.candidate).toMatchObject({ status: "changes", verdict: { sameHarness: false } });
    expect(delivered.at(-1)).toMatchObject({ seatId: "pc/term_author" });
    expect(delivered.at(-1)!.text).toContain("other.ts still exports the stale value");
    expect(leadNotices.at(-1)).toContain("CHANGES");
    expect((await owner(["status", "--directory", repo.root])).ok).toBe(false);

    // The author resubmits a new exact patch; the old verdict never covers it.
    repo.commit("other.ts", "export const other = 2;\n", "fix the other value");
    const second = result(await authorTools.submit({ summary: "Fix both values", issue: "VUH-2616" }));
    const resubmitted = second.body.candidate;
    expect(resubmitted.patchId).not.toBe(candidate.patchId);
    expect(resubmitted).toMatchObject({ supersedes: candidate.id, files: ["app.ts", "other.ts"] });
    expect(delivered.at(-1)!.text).toContain("other.ts still exports the stale value");
    expect(gate.get(candidate.id)).toMatchObject({ status: "superseded", supersededBy: resubmitted.id });
    expect(
      result(
        await reviewerTools.verdict({
          candidateId: candidate.id,
          patchId: candidate.patchId,
          verdict: "approve",
        }),
      ).body.error,
    ).toBe("superseded");
    expect((await owner(["status", "--directory", repo.root])).body).toMatchObject({
      status: "awaiting_review",
    });

    // APPROVE of the exact patch lets it land, and the approval survives a clean rebase.
    const approved = result(
      await reviewerTools.verdict({
        candidateId: resubmitted.id,
        patchId: resubmitted.patchId,
        verdict: "approve",
      }),
    );
    expect(approved.body.candidate.status).toBe("approved");
    expect(await owner(["status", "--directory", repo.root])).toMatchObject({
      ok: true,
      body: { landable: true, status: "approved" },
    });
    repo.run("switch", "-q", "main");
    writeFileSync(join(repo.root, "README.md"), "unrelated\n");
    repo.run("add", "README.md");
    repo.run("commit", "-q", "-m", "unrelated");
    repo.run("update-ref", "refs/remotes/origin/main", "HEAD");
    repo.run("switch", "-q", "feature");
    repo.run("rebase", "-q", "origin/main");
    expect((await owner(["status", "--directory", repo.root])).ok).toBe(true);

    // Any further change is a different patch and waits again.
    repo.commit("app.ts", "export const answer = 43;\n", "drift");
    expect((await owner(["status", "--directory", repo.root])).body).toMatchObject({
      status: "not_submitted",
      landable: false,
    });

    // The owner may waive one exact patch; who, why and the hash stay on its record.
    const waived = await owner([
      "waive",
      "--directory",
      repo.root,
      "--reason",
      "hotfix while the reviewer is away",
    ]);
    expect(waived.body).toMatchObject({
      candidate: {
        status: "waived",
        patchId: readCandidatePatch(repo.root).patchId,
        waiver: { actor: "owner", reason: "hotfix while the reviewer is away" },
      },
    });
    expect((await owner(["status", "--directory", repo.root])).ok).toBe(true);

    // With no reviewer named, nothing waits.
    review = undefined;
    expect((await owner(["status", "--directory", repo.root])).body).toMatchObject({
      required: false,
      landable: true,
    });
  } finally {
    service.close();
  }
});
