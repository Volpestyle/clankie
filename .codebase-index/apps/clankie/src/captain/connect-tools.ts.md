# apps/clankie/src/captain/connect-tools.ts

`connectionTools(deps, lane)` exposes connected Linear and email operations as Pi tool definitions. Linear search/get are available socially, while writes and all mailbox access stay operator-only; provider refusals are returned as model-readable JSON rather than thrown.

Tools: `linear_search`, `linear_get`, `linear_create`, `linear_update`, `linear_comment`, `linear_teams`, `email_list`, `email_read`, `email_search`, and `email_send`.
