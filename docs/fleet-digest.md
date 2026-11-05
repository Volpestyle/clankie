# Open the fleet digest

Run `clankie fleet digest` whenever you want a current fleet summary, or use
`clankie fleet digest --json` for the structured response. The owner read API
is `GET /v1/fleet/digest`; both use the owner's operator credential. This is an
on-demand read, with no model call, daily notification or repository change.

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

The [CLI reference](cli.md#fleet-digest---json) and OpenAPI describe the entry
point. No digest setting or scheduled delivery is required.
