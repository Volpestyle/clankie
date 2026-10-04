/** Native Claude arm readiness. Importing never starts a CLI, account or container. */
const missing = [
  {
    code: "claude-vendor-provenance-unavailable",
    detail:
      "Selected ELF bytes, their hash and an observed --version string do not establish official Claude provenance. No controller-owned authenticated vendor acquisition/digest route is implemented.",
  },
  {
    code: "claude-native-image-and-tui-proof-unavailable",
    detail:
      "The controller-created image/control and original-lifetime TUI path exists, but actual Linux containment, selected CLI compatibility, owner-visible foreground and descendant-stop acceptance remain unrun. Codex capabilities cannot authorize Claude.",
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
      "A protected collector requires the private controller launch token and fresh native foreground/lifetime checks; actual selected-version collection acceptance remains unrun. Hook/transcript bodies remain claims, never complete accounting.",
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
