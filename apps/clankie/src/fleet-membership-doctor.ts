import { isDeepStrictEqual } from "node:util";
import { projectsRevision } from "@clankie/settings";
import type { FleetMembershipReport, FleetPaneMembership } from "@clankie/protocol/projects";
import { createProjectMembershipResolver } from "./project-membership.ts";
import type { ProjectProcessProof } from "./project-process-proof.ts";

type Options = Parameters<typeof createProjectMembershipResolver>[0] & {
  machine: string;
  panes(): Promise<readonly { pane: string; harness: string }[]>;
  observe(fleet: string, pane: string): Promise<ProjectProcessProof | undefined>;
  /** Rechecks the exact registered connection captured by the owner route. No socket claim. */
  connected(): Promise<boolean>;
  supportedHarnesses: readonly string[];
};

/** Host-only diagnostics: this never returns a LocalFleetIdentity, bearer, or tool grant. */
export async function inspectFleetMembership(options: Options): Promise<FleetMembershipReport> {
  if (!(await options.connected())) throw new Error("Configured fleet unavailable");
  const inventory = await options.panes();
  const selected = inventory.slice(0, 64);
  const panes: FleetPaneMembership[] = [];
  const resolve = createProjectMembershipResolver(options);
  const inspect = async (entry: (typeof selected)[number]): Promise<FleetPaneMembership> => {
    const row: FleetPaneMembership = {
      ...entry,
      harnessSource: "herdr-inventory",
      nativeSession: "unavailable",
      hire: "unobserved",
      eligibility: "unproven",
      reason: "Native process, lifetime, and actual cwd could not be proven; bridge and tools are unverified.",
    };
    if (!options.supportedHarnesses.includes(entry.harness))
      return { ...row, eligibility: "unsupported", reason: "Native host proof does not support this harness." };
    try {
      const proof = await options.observe(options.machine, entry.pane);
      if (!proof || proof.fleet !== options.machine || proof.pane !== entry.pane) return row;
      const revision = projectsRevision(await options.settings());
      const { privateSeat: _privateSeat, ...assignmentProof } = proof;
      const hire = await options.hire(assignmentProof);
      row.nativeSession = proof.nativeSessionPending ? "pending" : "observed";
      row.hire = hire.state;
      if (proof.workspace?.machineId === options.machine) row.cwd = proof.workspace.canonicalPath;
      let membership: Awaited<ReturnType<typeof resolve>> = undefined;
      if (hire.state === "invalid") {
        row.eligibility = "stale";
        row.reason = "The host hire record is stale or invalid; workspace fallback is denied.";
      } else if (proof.privateSeat && hire.state !== "assigned") {
        row.eligibility = "private-unbound";
        row.reason = "The private native seat has no current bound hire.";
      } else if (proof.nativeSessionPending && hire.state !== "none") {
        row.eligibility = "ineligible";
        row.reason = "Native session reporting is pending; a hired/private seat cannot use startup eligibility.";
      } else {
        // Reuse the tool policy, with host connection/proof checks explicitly substituting
        // for transport checks ONLY in this read-only report. No request identity is admitted.
        membership = await resolve({
          pane: entry.pane,
          validate: options.connected,
          projectProof: () => options.observe(options.machine, entry.pane),
        });
        row.eligibility = membership ? "eligible" : "ineligible";
        row.reason = membership
          ? "Host-observed project eligibility only; the native bridge socket and tool catalog were not verified."
          : "Project workspace/root or hire policy did not match, or a required observation was unavailable.";
      }
      if (
        !(await options.connected()) ||
        !isDeepStrictEqual(await options.observe(options.machine, entry.pane), proof) ||
        !isDeepStrictEqual(await options.hire(assignmentProof), hire) ||
        projectsRevision(await options.settings()) !== revision
      ) {
        const { cwd: _cwd, ...unstable } = row;
        return {
          ...unstable,
          eligibility: "stale",
          reason: "Connection, native occupant, hire, or project settings changed during inspection; retry.",
        };
      }
      return membership ? { ...row, projectId: membership.projectId } : row;
    } catch {
      const { cwd: _cwd, projectId: _project, ...unproven } = row;
      return { ...unproven, eligibility: "unproven", reason: "A required host observation failed; retry. Native tools are unverified." };
    }
  };
  // Bound SSH work; preserve inventory order without launching one probe per pane at once.
  for (let offset = 0; offset < selected.length; offset += 2)
    panes.push(...(await Promise.all(selected.slice(offset, offset + 2).map(inspect))));
  if (!(await options.connected())) throw new Error("Configured fleet changed during inspection");
  return {
    machine: options.machine,
    observedAt: new Date().toISOString(),
    evidence: "host-process",
    nativeTools: "not-verified",
    totalPanes: inventory.length,
    truncated: inventory.length > selected.length,
    panes,
  };
}
