# ADR 0317: Setup starts with one read-only agent

Status: Accepted, 2026-11-01, on James's word approving it ("Build it into
setup"), after "its almost like, onbaording needs an agent from the beginning
to orient in the users setup" and "get permission granted". Amends
[ADR 0308](0308-watch-is-the-step-below-off.md) and
[ADR 0314](0314-setup-adds-the-phone-and-the-tailnet.md).

## Context

Setup can now add the phone and the tailnet machines (ADR 0314), but the
owner still has to know what to add. Which other computers run Herdr, which
repositories belong together, which tracker each uses (#79), which leads he
already runs: an agent can read all of that in a minute. Clankie should not
change anything because an agent said so. And Watch, the level a new owner
starts at, refuses every hire.

## Decision

- **One agent, offered after the Herdr session.** Once the owner has picked
  his session, setup offers to hire one setup agent on a Claude account he
  already uses. Saying no leaves plain Watch, with no agent, and the manual
  Add a device controls.
- **Read-only at the harness.** A hire can ask for `readOnly: true`
  (`SpawnOperatorSeatSchema`). Claude then starts in `dontAsk` mode, with an
  allow list of `Read`, `Glob`, `Grep`, four exact commands
  (`git status --short`, `git log --oneline -20`, `git remote -v`,
  `tailscale status --json`) and its two report tools. No command takes other
  arguments, since an open prefix lets an option such as `git log --output`
  write a file. Every other tool, including
  edits, other shell commands, the web and `clankie_call`, is refused without
  asking. Maximum trust mode never applies to it, and it refuses any
  permission, settings or extra-directory argument. Only a new Claude hire
  through its seat adapter can be read-only; other harnesses, resumed
  transcripts and bare terminal launches refuse it until they have an
  equivalent mode.
- **Watch steps aside for that one agent.** If Watch is on when the survey
  starts, Clankie turns it off (keeping Off's leaves) for the hire, and turns
  it back on when the survey ends: applied, declined, cancelled or failed.
  Approving an `autonomy` line replaces that restore with the owner's level.
  While the agent looks around, Clankie is at Off.
- **One proposal, in one report.** The brief carries what Clankie already
  knows (machines and sessions from discovery, projects, worker accounts). The
  agent sends one `message_clankie` with a fenced JSON block shaped as
  `SetupSurveyProposalSchema`: a summary, findings, and up to 24 lines. The
  service reads the agent's reports and takes the last block that parses.
- **Line by line.** The owner approves lines by id. Only approved lines run,
  through the same APIs setup and Settings use: `add_machine`,
  `connect_session`, `machine_access` and `autonomy`. `pair_phone`,
  `connect_lead` and `owner_step` are the owner's own steps: approving one
  shows him how, and nothing runs. Then Clankie closes the agent.
- **One API, every surface.** `GET`/`POST /v1/setup/survey`,
  `POST /v1/setup/survey/apply` and `POST /v1/setup/survey/cancel`, owner or a
  device with Take Control. `clankie setup-agent` covers it in the CLI. One
  survey runs at a time and survives a restart in the state directory.

## Consequences

- Tracker detection and repository grouping (#79), connecting a lead, and
  adding devices fold into the one proposal instead of separate questions.
- A lead line shows the owner how to connect that lead. Clankie does not yet
  check that the lead connected; that check is a follow-up.
- Codex has no allow-list mode Clankie can start yet, so the setup agent is
  Claude only. An owner with only Codex gets the manual controls.
