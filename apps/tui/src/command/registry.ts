/** One census for recognition and `clankie help`. Adding a noun is this table plus a dispatcher arm. */
const HEADLESS_COMMAND_HELP = [
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
    nouns: ["autostart"],
    lines: [
      "  autostart enable|disable|status",
      "                           Start clankie + relay at login via a user LaunchAgent (JSON)",
    ],
  },
  {
    nouns: ["pair"],
    lines: [
      "  pair [--json] [--timeout SEC]",
      "                           One-time device pairing QR + code (human default; --json for agents)",
    ],
  },
  { nouns: ["devices"], lines: ["  devices [--json]         List paired devices"] },
  {
    nouns: ["gateway"],
    lines: [
      "  gateway [status]         Public doorway configuration (JSON)",
      "  gateway set --url URL --host-id ID | disable",
    ],
  },
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
    nouns: ["herdr"],
    lines: [
      "  herdr [status] | set --session NAME",
      "                           Which herdr session the captain leads (default: default)",
    ],
  },
  {
    nouns: ["workdir"],
    lines: [
      "  workdir [status] | set PATH | clear",
      "                           The captain's working directory (default: the home directory)",
    ],
  },
  {
    nouns: ["stance"],
    lines: [
      "  stance <working|thinking|stuck|hauling|resting> [--note TEXT] [--for SECONDS]",
      "                           For agents: say what you are doing with your own figure",
      "                           in the commons. Your seat comes from HERDR_PANE_ID.",
    ],
  },
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
    "  Probe is GET {baseURL}/models (3s), unauthenticated — an endpoint that checks a",
    "  bearer answers 401, so pass --models id,id for those.",
    "  An endpoint that wants a key reads it from the credential store under the provider",
    "  id; put it there with /auth <providerId> in the console.",
    "  --set selects the first listed model as captain.",
    "  Config writes need `clankie restart captain` before the running service uses them.",
    "",
    "pair / devices / operator-credential rotate default to human text; pass --json.",
    "play stop prints 'Nothing is playing.' (not JSON) when idle.",
    "Secret entry lives in the console, not here: /auth, /discord, /connect, /voice. The",
    "credential store is shared — what /auth writes is what this CLI's services read.",
    "Local LLM servers are not launcher-owned; start them yourself.",
    "",
    "Full reference: docs/cli.md (at `clankie doctor`'s repoRoot on every install).",
  ].join("\n");
}
