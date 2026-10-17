import { isDeepStrictEqual } from "node:util";
import { realpath } from "node:fs/promises";
import { projectsRevision, resolveProjectMembership } from "@clankie/settings";
import type { SettingsStore } from "@clankie/settings";
import type { HerdrBinding } from "@clankie/protocol";
import { createProjectWorkspaceResolver, type ProjectHireLookup } from "./project-membership.ts";
import { nativeProcessStart, observeNativeCwd } from "./local-fleet-process.ts";
import type { ProjectProcessProof } from "./project-process-proof.ts";
import type { LocalCodexSeats } from "./local-codex-seats.ts";
import type { FixtureOriginalVerifier, FixtureOriginalSubject } from "./native-fixture-admissions.ts";
import type { FixtureObservation } from "./fixture-admission-contract.ts";

/** Real host ports only. No account/controller substitution or registration mutation. */
export function createFixtureOriginalVerifier(options: {
  settings: SettingsStore;
  seats: LocalCodexSeats;
  binding(): Promise<HerdrBinding | undefined>;
  observe(fleet: string, pane: string): Promise<ProjectProcessProof | undefined>;
  hire(proof: ProjectProcessProof): Promise<ProjectHireLookup>;
}): FixtureOriginalVerifier {
  const workspaceProject = createProjectWorkspaceResolver({
    settings: async () => (await options.settings.load()).projects,
    observe: options.observe,
  });
  const read = async (proof: ProjectProcessProof, observation: FixtureObservation) => {
    if (proof.fleet !== "default" || proof.nativeSessionPending || !proof.privateSeat)
      throw new Error("Original private Codex subject required");
    const { privateSeat: _private, ...native } = proof;
    const binding = await options.binding();
    if (
      !binding ||
      binding.socketPath !== proof.binding.socketPath ||
      binding.session !== proof.binding.session
    )
      throw new Error("Original Herdr binding changed");
    const settings = await options.settings.loadFenced();
    const candidates = options.seats
      .catalogCandidates(proof.pane)
      .filter(
        (candidate) =>
          candidate.nativeOccupantId === proof.nativeOccupantId &&
          isDeepStrictEqual(candidate.binding, proof.binding),
      );
    if (candidates.length !== 1) throw new Error("Original controller ambiguous or missing");
    const candidate = candidates[0]!;
    if (!candidate.threadId || !candidate.endpoint) throw new Error("Original controller unresolved");
    options.seats.assertCatalogCurrent(candidate);
    const hasController = observation.ancestors.some(
      (entry) =>
        entry.pid === candidate.pid &&
        nativeProcessStart(entry.birth, entry.kernelIdentity) === candidate.start,
    );
    if (
      !hasController ||
      !(await options.seats.allowsAdmission(
        observation.ancestors.map((entry) => entry.pid),
        proof.pane,
        binding,
        proof.nativeOccupantId,
      ))
    )
      throw new Error("Original controller admission refused");
    const current = await options.observe(proof.fleet, proof.pane);
    if (!isDeepStrictEqual(current, native)) throw new Error("Original native subject changed");
    const hire = await options.hire(native);
    if (hire.state !== "assigned") throw new Error("Original hire missing or changed");
    const projectId = await workspaceProject(native);
    const workspace = await observeNativeCwd(proof.processes[0]!.pid);
    if (
      !workspace ||
      (await realpath(workspace)) !== workspace ||
      projectId !== hire.projectId ||
      resolveProjectMembership(settings.settings.projects, { occupantId: hire.occupantId, hire }).outcome !==
        "member"
    )
      throw new Error("Original project or workspace changed");
    const final = () => {
      settings.assertCurrent();
      options.seats.assertCatalogCurrent(candidate);
    };
    if (
      !isDeepStrictEqual(await options.observe(proof.fleet, proof.pane), native) ||
      !isDeepStrictEqual(await options.hire(native), hire) ||
      !(await options.seats.allows(
        observation.ancestors.map((entry) => entry.pid),
        proof.pane,
        binding,
        proof.nativeOccupantId,
      ))
    )
      throw new Error("Original authority changed during preparation");
    final();
    const subject: FixtureOriginalSubject = {
      proof,
      controller: {
        pid: candidate.pid,
        start: candidate.start,
        threadId: candidate.threadId,
        endpoint: candidate.endpoint,
      },
      projectId: hire.projectId,
      workspace,
      hire,
      projectsRevision: projectsRevision(settings.settings.projects),
      hostUid: process.getuid!(),
      originalObservation: observation,
    };
    return { subject, final };
  };
  return {
    capture: async (proof, observation) => (await read(proof, observation)).subject,
    reprove: async (subject, observation) => {
      const current = await read(subject.proof, observation);
      const { originalObservation: _a, ...expected } = subject;
      const { originalObservation: _b, ...actual } = current.subject;
      if (!isDeepStrictEqual(actual, expected)) throw new Error("Original subject binding changed");
      return current.final;
    },
  };
}
