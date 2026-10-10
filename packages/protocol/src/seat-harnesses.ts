/**
 * Harnesses a seat may run, mostly Herdr's `agent start --kind` allowlist. A
 * harness value reaches an exec boundary, so it is checked against this list
 * rather than passed through as free text — the same reason membership is an
 * enum and not a string. `prime` (Prime Agent) has no Herdr kind: its adapter
 * launches a prepared native command and reports the pane itself.
 */
export const OPERATOR_SEAT_HARNESSES = [
  "claude",
  "codex",
  "pi",
  "prime",
  "gemini",
  "grok",
  "opencode",
  "copilot",
  "amp",
  "cursor",
  "devin",
  "agy",
  "cline",
  "omp",
  "mastracode",
  "kimi",
  "kiro",
  "droid",
  "hermes",
  "kilo",
  "qodercli",
  "qwen",
  "maki",
] as const;
export type OperatorSeatHarness = (typeof OPERATOR_SEAT_HARNESSES)[number];
