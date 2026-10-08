import { operatorHarness } from "./harness-command.ts";

/** One census for recognition and `clankie help`. Adding a noun is this table plus a dispatcher arm. */
const HEADLESS_COMMAND_HELP = [
  {
    nouns: ["heavy", "simulator"],
    lines: [
      "  heavy -- COMMAND [ARGS...]  Run a local heavy step with the machine-wide fleet permit",
      "  fleet resources           Inspect machine pressure, permit holders and queue (JSON)",
      "  simulator status | acquire JSON [--wait SECONDS] | touch JSON | release JSON  Lease a simulator to a verified local seat",
    ],
  },
  {
    nouns: ["checkouts"],
    lines: [
      "  checkouts status | sync [--repository OWNER_CHECKOUT] | prune --repository OWNER_CHECKOUT --path WORKTREE  Inspect, safely fast-forward, or tidy local repositories (JSON)",
      "  checkouts decide --repository OWNER_CHECKOUT --path WORKTREE --decision worth_landing|safe_to_drop --reason TEXT  Record a judgment of a worktree's unlanded work (JSON)",
    ],
  },
  {
    nouns: ["integrate"],
    lines: [
      "  integrate SHA... [--app SHA]... [--push] | status [UUID] | push UUID | revert UUID | holds | hold | release  Compose, isolate the full gate, and land approved commits (JSON)",
    ],
  },
  {
    nouns: ["share"],
    lines: [
      "  share [list | request JSON]  Control Activity shares on the current connection (owner/device, JSON)",
    ],
  },
  {
    nouns: ["harness"],
    lines: [
      "  harness install [--refresh-linked | --codex-source-setup SCRIPT] [--project PROJECT] [--approve]  Install or refresh native plugins under current fleet policy\n  harness refresh-tools [--pane PANE]  Refresh an original native catalog\n  harness restart-tools --pane PANE [--report /absolute/report]  Check native same-thread restart admission (local Codex exit unavailable)",
    ],
  },
  {
    nouns: ["project"],
    lines: [
      "  project create PROJECT --settings FILE.json --revision REVISION  Create a new local project from reviewed settings",
      "  project list | update PROJECT --changes FILE.json --revision REVISION  Read or edit project roles, models, limits and tracker binding",
      "  project settings PROJECT [--closure lead|owner|inherit] [--machine-setup lead|owner|inherit]  Read effective fleet policy or edit project overrides",
      "  project add|remove-workspace NAME --workspace PATH [--machine ID --platform windows|posix]  Manage approved project workspaces (JSON)",
      "  project add NAME --worktree-root ROOT --repo APPROVED_REPO [--machine ID --platform windows|posix]  Enroll a linked-worktree root",
      "  project remove-worktree-root NAME --worktree-root ROOT [--machine ID --platform windows|posix]  Remove a root enrollment",
    ],
  },
  {
    nouns: ["update"],
    lines: [
      "  update [--ref REF] | status [--json]  Explain the live runtime, target and deploy holds; JSON when piped",
      "  update --override-holds --reason TEXT  Owner-only update with one audited override per hold",
      "  update canary [--window-seconds N] [--sample-seconds N] [--cpu-percent N] [--health-ms N]  Read or configure post-update health budgets (CPU is advisory)",
    ],
  },
  {
    nouns: ["computer"],
    lines: [
      "  computer request JSON [--image-path NEW_PNG_PATH]  Drive the conversation-leased computer body (JSON)",
    ],
  },
  {
    nouns: ["body"],
    lines: ["  body status | request JSON  Inspect or explicitly request conversation body leases (JSON)"],
  },
  {
    nouns: ["login", "logout", "whoami", "connect", "disconnect", "fleet", "terminal", "keys", "deprovision"],
    lines: [
      "  login [--email EMAIL] [--url ORIGIN] [--code-stdin] [--machine ID]",
      "                           Sign in by email code: connects a hosted Clankie if the account has",
      "                           one, otherwise signs this Mac in for remote access",
      "  logout | whoami          Hosted sign-out (never touches remote access); whoami is also in `status`",
      "  Hosted restart/reset/deprovision require the account page/control plane.",
      "  fleet | terminal         Hosted fleet/terminal catalog; mutations use --json-stdin",
      "  keys [status|set PROVIDER --key-stdin|remove PROVIDER|validate PROVIDER]",
      "  connect hosted           Like login, but requires a hosted Clankie; disconnect is an alias for logout",
      "  disconnect               Forget this hosted client; hosted work continues",
    ],
  },
  {
    nouns: ["connections"],
    lines: ["  connections              Inspect runtime and connected-account inventory (JSON)"],
  },
  {
    nouns: ["runtime"],
    lines: [
      "  runtime [list|status] | connect ID (--session NAME | --socket PATH) | disconnect ID",
      "          workspaces ID (--repo /checkout | --dir /directory)... | workspaces ID --clear",
      "          capacity ID N|--clear (default 16; clear = unlimited)",
      "          prepare ID [--codex-source-setup SCRIPT] [--project PROJECT] [--approve]",
      "                           Manage named execution connections (JSON)",
    ],
  },
  {
    nouns: ["seat-sync"],
    lines: ["  seat-sync                Project the launched native seat transcript (hook stdin)"],
  },
  {
    nouns: ["seat-hook"],
    lines: ["  seat-hook                Report a hired seat's settled turn (worker plugin hook stdin)"],
  },
  {
    nouns: ["access"],
    lines: [
      "  access list | issue REQUEST.json --out GRANT.json | revoke ID | linear [verify]",
      "  access project NAME SERVER [--tool NAME]...",
      "                           Delegate connected MCP tools to a worker (JSON)",
    ],
  },
  {
    nouns: ["agents", "sessions"],
    lines: [
      "  agents contacts          Known agent identities and availability (JSON)",
      "  agents role ROLE --project PROJECT [--harness KIND --model NAME --effort LEVEL --subagent-model NAME --subagent-effort LEVEL --delegation native-first|panes --account LABEL --placement new-tab|split]\n  agents role NAME|ID ROLE|none [--project PROJECT] | roles | rename NAME|ID NEW_NAME",
      '                           Built-in (planner, builder, ...) or "custom role"; roles lists in use (JSON)',
      "  sessions                 Alias for agents session commands",
      "  agents [list] [--host ID] [--limit N] | read HOST:SESSION [--tail N | --after CURSOR]",
      "  agents resume HOST:SESSION [--fleet ID] [--brief TEXT]",
      "  agents hosts | hosts add ID --ssh TARGET [--shell posix|powershell] | hosts remove ID",
      "                           Read any Claude/Codex/Grok/Pi session, here or over SSH (JSON)",
    ],
  },
  {
    nouns: ["evaluator"],
    lines: [
      "  evaluator [status|enable [--harness codex|claude]|disable|open|retry ID]",
      "                           Developer diagnostic: independent assessments in Herdr (JSON)",
    ],
  },
  {
    nouns: ["conversations", "conversation"],
    lines: [
      "  conversations list | show ID [--cursor CURSOR] [--limit N] | tail ID [--cursor CURSOR]",
      "                           Inspect every conversation, including Discord tools (JSON)",
      "  conversations goal ID [status|accept|pause|resume|clear]",
      "  conversations goal ID set [--tokens N] <objective>",
      "  conversations channels | rooms | channel [ID] [--title T] [--member PERSONA_ID]...",
      "  conversations questions [ID] [--request UUID] [--status pending|submitted|cancelled]",
      "  conversations answer|cancel-question ID REQUEST --incarnation UUID --revision N [--option UUID | --text TEXT | --stdin | --worker-stdin]",
      "                [--discord provision [--room ROOM_ID] | --discord off | --webhook-stdin] | --json-stdin",
      "                           Agent channels and their managed-server Discord rooms (JSON)",
    ],
  },
  {
    nouns: ["reset"],
    lines: ["  reset --conversation ID  Archive the old session and reset model context (JSON)"],
  },
  {
    nouns: ["send"],
    lines: [
      "  send --conversation ID [--delivery steer|queue] [--attach PATH]... (MESSAGE | --stdin)",
      "                           Steer the active turn or queue a follow-up (JSON receipt);",
      "                           --attach uploads images or video with the message",
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
    nouns: ["runtime-health"],
    lines: [
      "  runtime-health [status|on|off]    Runtime CPU and slow-health alarm settings (JSON)",
      "  runtime-health set --cpu-percent N --health-ms N --sustained-seconds N",
      "                     [--sample-seconds N] [--cooldown-seconds N]",
    ],
  },
  {
    nouns: ["doctor"],
    lines: [
      "  doctor [--machine ID] [--json]    One-line diagnosis; --json shows the full install and fleet card",
      "                           (exit 0 when produced; JSON ok means the card was produced)",
    ],
  },
  {
    nouns: ["restart"],
    lines: ["  restart [service]        Restart in dependency order (JSON; progress on stderr)"],
  },
  {
    nouns: ["start"],
    lines: [
      "  start [service]          Start what is not running, in dependency order (JSON; progress on stderr)",
    ],
  },
  { nouns: ["stop"], lines: ["  stop [service]           Stop in reverse order (JSON; progress on stderr)"] },
  {
    nouns: ["recover"],
    lines: ["  recover [--autostart]    Restart launcher-owned services that crashed, with backoff (JSON)"],
  },
  {
    nouns: ["autostart"],
    lines: [
      "  autostart enable|disable|status",
      "                           Start clankie at login and restart crashed services every 30s (JSON)",
    ],
  },
  {
    nouns: ["awake"],
    lines: [
      "  awake [status|on|off]    Keep this Mac awake while plugged in (launcher-supervised caffeinate; JSON)",
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
    nouns: ["support"],
    lines: [
      "  support [list | create read-state|shell --hours 1..72 --ref REFERENCE]",
      "  support revoke ID | offer ID   Owner-issued support access (JSON)",
    ],
  },
  {
    nouns: ["remote-access", "gateway"],
    lines: [
      "  remote-access [status]   Remote access for this Mac (self-host only; gateway alias)",
      "  remote-access on [--email EMAIL] [--code-stdin]",
      "                           Sign this Mac in (or back in) with an email code",
      "  remote-access off | rotate-key | direct --control-plane-url URL --relay-url URL",
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
    lines: ["  play guide TEXT --conversation ID  Suggest a Pokémon objective or approach"],
  },
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
  {
    nouns: ["voice"],
    lines: [
      "  voice [status] | brain set openai|xai|anthropic [MODEL_ID] | brain model clear",
      "  voice model set MODEL_ID | model clear (ElevenLabs)",
    ],
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
      "  linear [status] | follow on|off | target [show|set ID]  Linear webhook wakes",
      "  linear budget            Read account request usage and background throttling",
      "  linear read TOOL --json-stdin [--background]   Read Linear; automated polls yield to interactive work",
      "  linear wake [show|set --actors owner,human,self,users --owner-user-ids IDS --owner-user-emails EMAILS --user-ids IDS --types TYPES --exclude-types TYPES]",
      "  linear post comment|issue --json-stdin   Publish as an existing worker persona through the connected app",
      "  linear graphql --json-stdin   Run any Linear GraphQL operation as the connected Clankie app",
    ],
  },
  {
    nouns: ["accounts"],
    lines: [
      "  accounts [list] | connect github|linear | complete linear --json-stdin | disconnect github|linear   Body account connections (JSON)",
      "  accounts start github | poll github --flow-id ID   Start and check GitHub device authorization separately",
      "  accounts connect linear-app --client-id ID --secret-stdin   Connect a workspace-owned Clankie app",
      "  accounts codex [list | add HOME --label LABEL | remove LABEL]   Local Codex homes and headroom",
      "  accounts claude [list | add HOME --label LABEL | remove LABEL]   Register existing local Claude profiles",
      "  accounts workers [--machine ID]   Worker Claude/Codex accounts on this or a linked machine: sign-in, plan, usage (JSON)",
      "  accounts hold|release claude|codex|pi LABEL [--machine ID] [--reason TEXT]   Keep an account out of automatic choice",
      "  accounts apps [set|clear] [--github-client-id ID] [--linear-client-id ID] [--linear-redirect-uri URL]",
      "  accounts apps github-secret --client-id ID --secret-stdin   Body-only developer revocation secret",
    ],
  },
  {
    nouns: ["work"],
    lines: [
      "  work [status] | repos | init [--backend B ...] | list [--status S] [--owner O] [--label L] | show ID",
      "  work create TITLE [--criterion C]... | update ID [--status S] [--check N]... | close ID",
      "  work attach ID --url URL --caption TEXT [--kind K]   [--repo PATH on any command]",
      "                           Track work in the repo's own convention, with evidence (JSON)",
    ],
  },
  {
    nouns: ["skills"],
    lines: ["  skills                   Skills shipped with this body (JSON)"],
  },
  {
    nouns: ["desktop"],
    lines: [
      "  desktop [status] | quiet-hours START END TIME_ZONE | quiet-hours off",
      "                           Desktop quiet hours (HH:mm, IANA time zone); applies immediately",
    ],
  },
  {
    nouns: ["games"],
    lines: [
      "  games status|set on|off  Read or set PokeAgent gameplay availability",
      "  games budget max-tokens|max-cost-usd|max-turns|max-duration-ms <value|default>",
    ],
  },
  {
    nouns: ["browser"],
    lines: [
      "  browser [status] | record on|off  Save each burst of his browsing as a WebM (JSON)",
      "  browser harnesses | delegate on|off",
      "                           Computer-use harnesses he can hire, and whether he is offered them (JSON)",
      "  browser tools | call TOOL JSON  Inspect or call Browser Use Pi tools",
    ],
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
    nouns: ["minecraft"],
    lines: [
      "  minecraft configure [PROFILE HOST --version VERSION --port PORT]",
      "  minecraft configure play [--enabled on|off] [--model PROVIDER/MODEL]",
      "      [--max-tokens N] [--max-cost-usd N] [--turn-interval-ms N]",
      "      [--idle-backoff-ms N] [--idle-stop-ms N]",
      "  minecraft driver [mind|owner|worker fleet:FLEET:pane:SEAT]",
      "  minecraft status|profiles|join PROFILE|leave|cancel [ACTION]|pause|resume",
      "  minecraft observe|chat TEXT|follow PLAYER|goto X Y Z|dig X Y Z|place X Y Z ITEM",
      "                           Play in an approved offline Java server (JSON)",
    ],
  },
  {
    nouns: ["fleet"],
    lines: [
      "  fleet status|set [--notes TEXT] [--size max|large|small|solo] [--models optimal|efficient]|clear",
      "          [--closure lead|owner] [--machine-setup lead|owner] [--tools connected|off] [--peer-messages on|off] [--hire-profile FILE.json]",
      "                           Read or set fleet routing, budget, autonomy and connected tools",
    ],
  },
  {
    nouns: ["machines"],
    lines: [
      "  machines [list|discover] [--json] | add NAME --ssh HOST | remove NAME | sessions NAME",
      "                           Machines where agents run; connections apply live",
    ],
  },
  {
    nouns: ["herdr"],
    lines: [
      "  herdr [status|open|create|disable] | use NAME",
      "                           Open his workspace or choose your Herdr session",
      "  herdr [--connection ID] <herdr command>    Run against a selected runtime",
      "  herdr prepare NAME [--codex-source-setup SCRIPT] [--project PROJECT] [--approve]",
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
    nouns: ["work-on"],
    lines: [
      "  work-on TITLE [--repo REPO_ID --issue ISSUE_ID] | clear",
      "                           For agents: state your current assignment and optional issue link.",
      "                           Persists for this native session; HERDR_PANE_ID identifies your seat.",
    ],
  },
  {
    nouns: ["hire-receipt"],
    lines: [
      "  hire-receipt settle ORIGINAL_ID [not-launched|delivered|abandoned|abandoned-unknown]",
      "                           Recover an authenticated original; retain its identity and evidence.",
      "  hire-receipt fresh --json-stdin",
      "                           Explicit new remote work after settlement; retain freshIntent UUIDs.",
    ],
  },
  {
    nouns: ["seat-delivery"],
    lines: [
      "  seat-delivery list         Unresolved head seat deliveries and their age.",
      "  seat-delivery settle RECEIPT_ID abandoned-unknown [--conversation ID]",
      "                           Owner settlement: never claims receipt, never resends the original.",
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
      "  prompt [--lane LANE] [--sections identity,persona,reach,fleet,address,model,conversation] [--harness claude]",
      "                           The system prompt that lane's session starts from (plain text)",
    ],
  },
  {
    nouns: ["memory-card"],
    lines: [
      "  memory-card [--lane LANE] [--hook]",
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
      "  metrics --fleet          Fleet proof/report failure counts and 5/60-minute rates (JSON)",
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
    nouns: ["claude", "claude2", "codex", "opencode", "grok"],
    lines: [
      "  claude[N]               Open Clankie in claude or a numbered shell account command (e.g. claude2)",
      "  codex[N]                Open Codex; a numbered command selects its exact registered account label",
      "  opencode                Open Clankie in OpenCode (TTY)",
      "  grok                    Open Clankie in Grok Build (TTY; macOS, 1.0.46)",
      "    [--resume] [--conversation ID | --new] [--plugin-dir PATH] [--dry-run]",
      "                           Without a selection: the global chat while no live seat holds it, else a new chat; --new forces one",
      "                           Grok accepts --resume, --conversation, --new and --dry-run; no --plugin-dir",
      "                           --dry-run prints a plan without creating a chat",
    ],
  },
  { nouns: ["seat"], lines: [] }, // Hidden compatibility alias; internal hooks keep their separate names.
  {
    nouns: ["mcp"],
    lines: [
      "  mcp [--lane operator] [--conversation ID] Serve Clankie's lane tool bank over stdio for a seated harness",
      "  mcp --seat               Serve a fleet pane's message channel over stdio (no tools)",
      "  mcp --fleet              Serve owner-granted fleet tools through the process-authenticated local or SSH link",
      "  mcp --grant FILE         Serve only a worker's granted connected tools over stdio",
    ],
  },
  {
    nouns: ["discord"],
    lines: ["  discord [status]         Read non-secret Discord identifiers and body selection"],
  },
  { nouns: ["discord"], lines: ["  discord set --field value […] | clear --field […]"] },
  {
    nouns: ["discord"],
    lines: ["  discord setup [choices home|talk|computer|team]  Read sentences or set their named choices"],
  },
  {
    nouns: ["discord"],
    lines: ["  discord directory [servers|channels|roles|people] [--server ID] [--limit N] [--after ID]"],
  },
  {
    nouns: ["discord"],
    lines: ["  discord definition       Read the shared Discord sentences, pickers and Advanced fields"],
  },
  {
    nouns: ["discord"],
    lines: ["  discord transcripts [--cursor CURSOR] [--limit N]  Read private retained voice text"],
  },
  {
    nouns: ["discord"],
    lines: ["  discord official [status|on|off]  Free official Clankie bot through your Clankie account"],
  },
] as const;

export const HEADLESS_NOUNS: readonly string[] = [
  // `down` is the former name of `stop`; update helpers from older runtimes still call it.
  ...new Set([...HEADLESS_COMMAND_HELP.flatMap((entry) => [...entry.nouns]), "down"]),
];

export function isHeadlessCaptainCommand(command: string | undefined): boolean {
  return (
    operatorHarness(command) !== undefined ||
    command === "help" ||
    command === "--help" ||
    command === "-h" ||
    HEADLESS_NOUNS.includes(command ?? "")
  );
}

/** Words people reach for that name a different launcher command. */
const LAUNCHER_COMMAND_HINTS: Readonly<Record<string, string>> = {
  up: "start",
  kill: "stop",
};

/**
 * The launcher opens the console only when no command is given. Any other
 * word that is not a headless command must be refused before the launcher
 * starts the service for a console that will never open.
 */
export function unknownLauncherCommand(command: string | undefined): string | undefined {
  if (command === undefined || isHeadlessCaptainCommand(command)) return undefined;
  const hint = LAUNCHER_COMMAND_HINTS[command];
  return hint === undefined
    ? `unknown command "${command}"; run \`clankie help\``
    : `unknown command "${command}"; did you mean \`clankie ${hint}\`? Run \`clankie help\` for all commands`;
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
    "Services for start/stop/restart: all (default), clankie, relay, discord, user-session, activity, tunnel",
    "Aliases: captain, eve, cp, control-plane, bridge, lab, watch, viewer, cloudflared, app-relay, phone",
    "",
    "Model notes:",
    "  A bare origin (--base-url http://127.0.0.1:8000) is rewritten to /v1.",
    "  Probe is GET {baseURL}/models (3s), unauthenticated — an endpoint that checks a",
    "  bearer answers 401, so pass --models id,id for those.",
    "  An endpoint that wants a key reads it from the credential store under the provider",
    "  id; put it there with /auth <providerId> in the console.",
    "  --set selects the first listed model as captain.",
    "  Config writes need `clankie restart`, except Linear follow (live).",
    "",
    "pair / devices / operator-credential rotate default to human text; pass --json.",
    "play stop prints 'Nothing is playing.' (not JSON) when idle.",
    "prompt / memory-card print plain text, and only for the bearer's own lane:",
    "  operator, discord_voice, discord_presence, gameplay (default: operator).",
    "claude / codex / opencode / grok need a TTY and that harness on PATH; mcp speaks JSON-RPC and is",
    "  for a harness's MCP config, not for people.",
    "Secret entry uses /auth, /discord, /connect, /voice, or rivals connect --token-stdin. The",
    "credential store is shared — what /auth writes is what this CLI's services read.",
    "Local LLM servers are not launcher-owned; start them yourself.",
    "",
    "Full reference: docs/cli.md (at `clankie doctor`'s repoRoot on every install).",
  ].join("\n");
}
