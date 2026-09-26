/** One census for recognition and `clankie help`. Adding a noun is this table plus a dispatcher arm. */
const HEADLESS_COMMAND_HELP = [
  {
    nouns: ["connections"],
    lines: ["  connections              Inspect runtime, Swarm and connected-account inventory (JSON)"],
  },
  {
    nouns: ["runtime"],
    lines: [
      "  runtime [list|status] | connect ID (--session NAME | --socket PATH) | disconnect ID",
      "          workspaces ID (--repo /checkout | --dir /directory)... | workspaces ID --clear",
      "          capacity ID N|--clear | budget N|--clear (per coordinator scope; default 16; clear = unlimited)",
      "                           Manage named execution connections (JSON)",
    ],
  },
  {
    nouns: ["seat-sync"],
    lines: ["  seat-sync                Project the launched Claude seat transcript (hook stdin)"],
  },
  {
    nouns: ["access"],
    lines: [
      "  access list | issue REQUEST.json (--out GRANT.json | --deliver swarm) | revoke ID | linear [verify]",
      "                           Delegate connected MCP tools to a worker (JSON)",
    ],
  },
  {
    nouns: ["agents"],
    lines: [
      "  agents [list] [--host ID] [--limit N] | read HOST:SESSION [--tail N | --after CURSOR]",
      "  agents send HOST:SESSION MESSAGE | runs [RUN] | cancel RUN | release RUN",
      "  agents hosts | hosts add ID --ssh TARGET [--shell posix|powershell] | hosts remove ID",
      "                           Read or resume any Claude/Codex/Grok/Pi session, here or over SSH (JSON)",
    ],
  },
  {
    nouns: ["swarm"],
    lines: [
      "  swarm [status|connections] | connect PRIVATE.json | disconnect ID",
      "  swarm contacts | thread PERSONA | message PERSONA TEXT",
      "                           Inspect or connect an authorized Swarm coordinator (JSON)",
    ],
  },
  {
    nouns: ["evaluator"],
    lines: [
      "  evaluator [status|enable [--harness codex|claude]|disable|open|retry ID]",
      "                           Independent task assessments in Herdr (JSON)",
    ],
  },
  {
    nouns: ["conversations", "conversation"],
    lines: [
      "  conversations list | show ID [--cursor CURSOR] [--limit N] | tail ID [--cursor CURSOR]",
      "                           Inspect every conversation, including Discord tools (JSON)",
    ],
  },
  {
    nouns: ["reset"],
    lines: ["  reset --conversation ID  Archive the old session and reset model context (JSON)"],
  },
  {
    nouns: ["send"],
    lines: [
      "  send --conversation ID [--delivery steer|queue] (MESSAGE | --stdin)",
      "                           Steer the active turn or queue a follow-up (JSON receipt)",
    ],
  },
  {
    nouns: ["file"],
    lines: [
      "  file publish --conversation ID PATH [--name FILE] [--type MEDIA_TYPE]",
      "                           Publish one finished local file into the conversation (JSON)",
    ],
  },
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
  { nouns: ["model"], lines: ["  model refresh            Refresh the available model catalog"] },
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
  {
    nouns: ["linear"],
    lines: [
      "  linear [status] | follow on|off | inbox [read | ack CURSOR]  Linear awareness and unread activity",
      "  linear work list | bind ORG ISSUE CONVERSATION [--from ID] | unbind ORG ISSUE CONVERSATION",
    ],
  },
  { nouns: ["games"], lines: ["  games status|set on|off  Read or set PokeAgent gameplay availability"] },
  {
    nouns: ["browser"],
    lines: ["  browser [status] | record on|off  Save each burst of his browsing as a WebM (JSON)"],
  },
  {
    nouns: ["rivals"],
    lines: [
      "  rivals connect URL [--token-stdin] | disconnect | status",
      "  rivals start autonomous|combat|disengage [NOTE]",
      "  rivals objective SESSION MODE [NOTE]",
      "  rivals observe|stop SESSION | share SESSION [GUILD CHANNEL]",
      "                           Play Spider-Man through the Rivals Agent bridge (JSON)",
    ],
  },
  {
    nouns: ["fleet"],
    lines: [
      "  fleet status|set [--notes TEXT] [--size max|large|small|solo] [--models optimal|efficient]|clear",
      "                           Read or set how he routes work and how big a swarm he aims for",
    ],
  },
  {
    nouns: ["herdr"],
    lines: [
      "  herdr [status|open|disable] | set --runtime auto|bundled|external|disabled | set --session NAME",
      "                           Bundled runtime or an external Herdr session",
      "  herdr [--connection ID] <herdr command>    Run against a selected runtime",
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
    nouns: ["prompt"],
    lines: [
      "  prompt [--lane LANE] [--sections identity,persona,reach,fleet,address,model]",
      "                           The system prompt that lane's session starts from (plain text)",
    ],
  },
  {
    nouns: ["memory-card"],
    lines: [
      "  memory-card [--lane LANE]",
      "                           The memory card that lane's next run injects (plain text)",
    ],
  },
  {
    nouns: ["memory"],
    lines: [
      "  memory [status] | search <terms...>",
      "  memory retain|release|forget <episodeId>",
      "  memory correct <episodeId> --summary TEXT",
      "                           Inspect and curate remembered episodes (JSON)",
    ],
  },
  {
    nouns: ["metrics"],
    lines: [
      "  metrics [--run ID] [--limit N]",
      "                           Recent settled captain turns: execution identity, tool shape,",
      "                           reported usage (JSON; newest first, limit 1-100, default 20)",
    ],
  },
  {
    nouns: ["telemetry"],
    lines: [
      "  telemetry ship --spool DIR --cursor FILE --log-group NAME [--once] [--interval S]",
      "                           Hosted host only: ship a body's metadata telemetry to CloudWatch Logs",
    ],
  },
  {
    nouns: ["seat"],
    lines: [
      "  seat [--resume] [--conversation ID] [--plugin-dir PATH] [--dry-run]",
      "                           Sit in Claude Code as Clankie (TTY); --dry-run prints the launch plan (JSON)",
    ],
  },
  {
    nouns: ["mcp"],
    lines: [
      "  mcp [--lane operator] [--conversation ID] Serve Clankie's lane tool bank over stdio for a seated harness",
      "  mcp --seat               Serve a fleet pane's message channel over stdio (no tools)",
      "  mcp --grant FILE         Serve only a worker's granted connected tools over stdio",
      "  mcp --swarm              Serve an enrolled worker's explicit grants; no operator access",
      "  mcp --swarm-grant ID     Retrieve a worker grant using its enrolled Swarm session",
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
    "  Config writes need `clankie restart captain`, except Linear follow which applies live.",
    "",
    "pair / devices / operator-credential rotate default to human text; pass --json.",
    "play stop prints 'Nothing is playing.' (not JSON) when idle.",
    "prompt / memory-card print plain text, and only for the bearer's own lane:",
    "  operator, discord_voice, discord_presence, gameplay (default: operator).",
    "seat needs a TTY and Claude Code on PATH; mcp speaks JSON-RPC on stdout and is",
    "  for a harness's MCP config, not for people.",
    "Secret entry uses /auth, /discord, /connect, /voice, or rivals connect --token-stdin. The",
    "credential store is shared — what /auth writes is what this CLI's services read.",
    "Local LLM servers are not launcher-owned; start them yourself.",
    "",
    "Full reference: docs/cli.md (at `clankie doctor`'s repoRoot on every install).",
  ].join("\n");
}
