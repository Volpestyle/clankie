# Open the fleet digest

Run `clankie fleet digest` whenever you want a current fleet summary, or use
`clankie fleet digest --json` for the structured response. The owner read API
is `GET /v1/fleet/digest`; both use the owner's operator credential. This is an
on-demand read, with no model call, notification or repository change. For what
the fleet did since the last scheduled digest, see
[the daily digest](#the-daily-digest).

Pending owner decisions come first, then blocked workers and incomplete source
observations. The rest shows current hired workers and statuses, today's done
and blocked reports, confirmed closes, retained open/merged PR counts, anonymous
account burn and capacity/machine observations.

The response contains aggregate numbers, timestamps and availability. It
excludes report and question bodies, agent names and titles, PR titles and
repository URLs/identifiers, account labels, emails, credentials, paths, board
note text and raw source errors. It does not offer or acknowledge reports,
answer questions or change inbox state. Reading the digest does not grant any
authority to send or act on a question.

## What the numbers cover

- The date and today's report/close counts use UTC. A done report is an agent's
  report, not proof that its work landed.
- Hired workers are the current fleet's confirmed hires. The digest does not
  invent a daily hiring history from first sightings or vanished panes.
- Close counts use retained records with a confirmed `closed` state. An
  unconfirmed close, reopened worker or disappearance is not a confirmed close.
- PR totals come from the existing changes-feed source: all observed open PRs
  and retained merged records. The retention cutoff is based on provider update
  time; these totals do not claim that every merged PR merged today.
- Burn counts use `fleet_capacity`'s existing account observations. Projected
  exhaustion is a projection, and unknown pace stays unknown. Known token totals
  cover the source's readable last-hour observations, not an estimate for
  unobserved sessions or machines. Missing account token data is counted.
- Heavy slots/holders/queue and machine availability are observations, not
  permission to admit work. Joined-machine readings retain their advisory
  meaning.

These are retained observations, not a complete daily audit log. An unavailable
or disabled source yields `unknown`, never an empty-success claim. When Herdr
discovery is disabled, capacity and burn are also unknown because the capacity
reader refreshes native seats. The JSON includes source availability; incomplete
sources appear in the attention list.
The server rechecks operator credentials, repository/provider visibility and
discovery before publishing. Responses are `no-store`; a lost or changed
authorization refuses the read.

The [CLI reference](cli.md#fleet-digest---daily---json) and OpenAPI describe the
entry point.

## The daily digest

The service also generates a digest once a day. Run
`clankie fleet digest --daily` (or `--json`), or read
`GET /v1/fleet/digest/daily`, with the same owner credential.

Change the time with `clankie fleet set --digest-time HH:mm`, or stop it with
`--digest-time off`. The default is `08:00` in the host's time zone. If that time
falls in the owner's desktop quiet hours, the digest is generated when they end
and keeps that day's date. A service that was down generates it at its next
check. Changing the time takes effect from the next day that has no digest yet.

Each digest covers the time since the previous one, up to seven days. The first
covers the last 24 hours. It counts:

- PRs opened and merged, and issues opened and closed, by GitHub's own timestamps
  across the enrolled repositories. A `ci-finding` label marks CI findings: those
  filed in the window, and those open at generation.
- Confirmed project hires, from the hire ledger. A worker started outside a
  project isn't counted.
- Confirmed closes, and done and blocked reports. A done report isn't proof that
  work landed.
- Accounts against pace, using the same burn fields as the on-demand digest.

Owner decisions and blocked workers aren't stored. Every read observes them
live, so a wait resolved after generation never appears. `waits.observedAt` says
when, and `digest.generatedAt` dates the rest.

Only the latest digest is kept, at `fleet-daily-digest.json` in the service's
state directory. A source that fails records `unknown`, not zero. Generation
sends nothing, makes no model call and notifies nobody.

Connected lead apps can't read the daily digest yet: both routes need the owner's
operator credential ([#164](https://github.com/Volpestyle/clankie/issues/164)).
