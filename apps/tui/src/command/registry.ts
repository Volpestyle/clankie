/** One census for recognition and `clankie help`. Adding a noun is this table plus a dispatcher arm. */
export const HEADLESS_COMMAND_HELP = [
  {
    nouns: ["health", "status"],
    lines: ["  health | status          Probe every launcher-owned service (JSON)"],
  },
  {
    nouns: ["doctor"],
    lines: [
      "  doctor                   This install: checkout vs release, models, credentials, herdr",
      "                           (JSON; exit 0 — ok means the card was produced)",
    ],
  },
  {
    nouns: ["restart"],
    lines: ["  restart [service]        Restart in dependency order (JSON; progress on stderr)"],
  },
  { nouns: ["down"], lines: ["  down [service]           Stop in reverse order (JSON; progress on stderr)"] },
  {
    nouns: ["pair"],
    lines: [
      "  pair [--json] [--timeout SEC]",
      "                           One-time device pairing QR + code (human default; --json for agents)",
    ],
  },
  { nouns: ["devices"], lines: ["  devices [--json]         List paired devices"] },
  {
    nouns: ["devices"],
    lines: ["  devices revoke <id> [--json]", "                           Revoke a device"],
  },
  {
    nouns: ["operator-credential"],
    lines: [
      "  operator-credential rotate [--json]",
      "                           Rotate the local operator credential",
    ],
  },
  { nouns: ["play"], lines: ["  play status              Live embodiment session (JSON)"] },
  {
    nouns: ["play"],
    lines: ["  play stop                Stop the live playthrough at the next turn boundary"],
  },
  { nouns: ["model"], lines: ["  model [status]           Captain model and local providers (JSON)"] },
  {
    nouns: ["model"],
    lines: [
      "  model add-local --id ID --base-url URL [--context N] [--models id,id] [--set]",
      "                           Declare an OpenAI-compatible local runtime (ds4, Ollama, LM Studio)",
    ],
  },
  { nouns: ["model"], lines: ["  model set provider/model Select the captain model"] },
  { nouns: ["effort"], lines: ["  effort [status]          Read reasoning effort for the captain model"] },
  {
    nouns: ["effort"],
    lines: ["  effort set LEVEL [--model provider/model] | clear [--model provider/model]"],
  },
  { nouns: ["image-model"], lines: ["  image-model [status] | set provider/model | clear"] },
  { nouns: ["video-model"], lines: ["  video-model [status] | set provider/model | clear"] },
  { nouns: ["persona"], lines: ["  persona [status]         Read owner-authored character configuration"] },
  {
    nouns: ["persona"],
    lines: ["  persona set --display-name NAME [--aliases name,name] [--character-notes TEXT] …"],
  },
  { nouns: ["games"], lines: ["  games status|set on|off  Read or set PokeAgent gameplay availability"] },
  {
    nouns: ["discord"],
    lines: ["  discord [status]         Read non-secret Discord identifiers and body selection"],
  },
  { nouns: ["discord"], lines: ["  discord set --field value […] | clear --field […]"] },
] as const;

export const HEADLESS_NOUNS: readonly string[] = [
  ...new Set(HEADLESS_COMMAND_HELP.flatMap((entry) => [...entry.nouns])),
];

export function isHeadlessCaptainCommand(command: string | undefined): boolean {
  return (
    command === "help" || command === "--help" || command === "-h" || HEADLESS_NOUNS.includes(command ?? "")
  );
}

export function commandHelp(): string {
  return [
    "Usage: clankie [--version|-V] [--chat <conversationId>] [<command> ...]",
    "",
    "With no command, clankie opens the fullscreen operator console and requires a TTY.",
    "",
    "Headless commands (no TTY). One JSON document on stdout unless noted; progress",
    "on stderr. Exit 0 on success, 1 on failure. Secrets never as flags.",
    "",
    ...HEADLESS_COMMAND_HELP.flatMap((entry) => [...entry.lines]),
    "  help | --help | -h       This text",
    "",
    "Services for restart/down: all (default), clankie, relay, discord, user-session, activity, tunnel",
    "Aliases: captain, eve, cp, control-plane, bridge, lab, watch, viewer, cloudflared, app-relay, phone",
    "",
    "Model notes:",
    "  A bare origin (--base-url http://127.0.0.1:8000) is rewritten to /v1.",
    "  Probe is GET {baseURL}/models (3s). If that fails, pass --models id,id.",
    "  --set selects the first listed model as captain.",
    "  Config writes need `clankie restart captain` before the running service uses them.",
    "",
    "pair / devices / operator-credential rotate default to human text; pass --json.",
    "play stop prints 'Nothing is playing.' (not JSON) when idle.",
    "Not on this CLI: secret entry for /auth, /discord, or /connect; /voice. Local LLM servers are",
    "not launcher-owned; start them yourself.",
    "",
    "Full reference: docs/cli.md (at `clankie doctor`'s repoRoot on every install).",
  ].join("\n");
}
