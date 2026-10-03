/** Native Claude arm readiness. Importing never starts a CLI, account or container. */
const missing = [
  {
    code: "claude-native-image-and-tui-proof-unavailable",
    detail:
      "No pinned Claude image/binary and kernel-bound interactive TUI capability issuer exists. Codex capabilities cannot authorize Claude.",
  },
  {
    code: "claude-provider-account-observer-unavailable",
    detail:
      "No controller-origin Claude account identity, ordinary-usage permission and account-wide five-hour/seven-day quota observer is implemented.",
  },
  {
    code: "claude-physical-request-fence-unavailable",
    detail:
      "No fail-closed admission boundary covers every root, subagent, retry and compaction model request. Command-hook timeout can allow a prompt to proceed.",
  },
  {
    code: "claude-descendant-allocation-proof-unavailable",
    detail:
      "No native prelaunch boundary proves complete descendant inventory and independently allocated workspaces/indexes. Subagent hooks and transcript discovery are observations only.",
  },
  {
    code: "claude-transcript-provenance-collector-unavailable",
    detail:
      "No protected live Claude transcript collector is bound to the exact native process. Supplied hook/transcript bytes cannot establish origin or accounting completeness.",
  },
];

/** Deliberately no imported proof, fixture flag or operator override can authorize this arm. */
export function nativeClaudeArmReadiness() {
  return {
    status: "unsupported",
    reason: "native-claude-capabilities-unavailable",
    arm: "native-subagents",
    approvalEstablished: false,
    launchAllowed: false,
    missing: structuredClone(missing),
    execution: "unrun",
  };
}
